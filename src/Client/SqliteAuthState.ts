import fs from 'fs/promises';
import path from 'path';
import sqlite3 from 'sqlite3';
import {
	AuthenticationState,
	BufferJSON,
	initAuthCreds,
	proto,
	SignalDataTypeMap,
} from 'baileys';

type AuthRow = {
	value: string;
};

type SqliteDatabase = sqlite3.Database;

const DEFAULT_DB_PATH = './baileys-auth.sqlite';
const DEFAULT_MULTI_FILE_AUTH_DIR = './creds';

const fixFileName = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-');

const createDatabase = (dbPath: string) =>
	new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);

const run = (db: SqliteDatabase, sql: string, params: unknown[] = []) =>
	new Promise<void>((resolve, reject) => {
		db.run(sql, params, err => {
			if (err) {
				reject(err);
				return;
			}

			resolve();
		});
	});

const get = <T>(db: SqliteDatabase, sql: string, params: unknown[] = []) =>
	new Promise<T | undefined>((resolve, reject) => {
		db.get(sql, params, (err, row) => {
			if (err) {
				reject(err);
				return;
			}

			resolve(row as T | undefined);
		});
	});

const initAuthDatabase = async (db: SqliteDatabase) => {
	await run(db, 'PRAGMA journal_mode = WAL');
	await run(db, 'PRAGMA busy_timeout = 5000');
	await run(
		db,
		`CREATE TABLE IF NOT EXISTS baileys_auth_state (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)`
	);
};

const makeStorage = (db: SqliteDatabase) => {
	const storageKey = (file: string) => fixFileName(file);

	const writeData = async (data: unknown, file: string) => {
		await run(
			db,
			`INSERT INTO baileys_auth_state (key, value, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET
				value = excluded.value,
				updated_at = excluded.updated_at`,
			[storageKey(file), JSON.stringify(data, BufferJSON.replacer), Date.now()]
		);
	};

	const readData = async <T>(file: string): Promise<T | null> => {
		const row = await get<AuthRow>(
			db,
			'SELECT value FROM baileys_auth_state WHERE key = ?',
			[storageKey(file)]
		);

		if (!row) {
			return null;
		}

		return JSON.parse(row.value, BufferJSON.reviver) as T;
	};

	const removeData = async (file: string) => {
		await run(db, 'DELETE FROM baileys_auth_state WHERE key = ?', [
			storageKey(file),
		]);
	};

	const hasData = async (file: string) => {
		const row = await get<{ key: string }>(
			db,
			'SELECT key FROM baileys_auth_state WHERE key = ?',
			[storageKey(file)]
		);

		return Boolean(row);
	};

	return {
		writeData,
		readData,
		removeData,
		hasData,
	};
};

const migrateMultiFileAuthState = async (
	authDir: string,
	storage: ReturnType<typeof makeStorage>
) => {
	if (await storage.hasData('creds.json')) {
		return;
	}

	const files = await fs.readdir(authDir).catch(() => []);
	const jsonFiles = files.filter(file => file.endsWith('.json'));

	if (jsonFiles.length === 0) {
		return;
	}

	for (const file of jsonFiles) {
		const filePath = path.join(authDir, file);
		const raw = await fs.readFile(filePath, 'utf-8').catch(() => undefined);

		if (!raw) {
			continue;
		}

		await storage.writeData(JSON.parse(raw, BufferJSON.reviver), file);
	}

	console.log(`Migrated ${jsonFiles.length} Baileys auth files into SQLite`);
};

export const useSqliteAuthState = async (
	dbPath = process.env.BAILEYS_AUTH_DB_PATH || DEFAULT_DB_PATH,
	multiFileAuthDir = DEFAULT_MULTI_FILE_AUTH_DIR
): Promise<{
	state: AuthenticationState;
	saveCreds: () => Promise<void>;
}> => {
	const db = createDatabase(dbPath);
	await initAuthDatabase(db);

	const storage = makeStorage(db);
	await migrateMultiFileAuthState(multiFileAuthDir, storage);

	const creds = (await storage.readData<AuthenticationState['creds']>(
		'creds.json'
	)) || initAuthCreds();

	return {
		state: {
			creds,
			keys: {
				get: async <T extends keyof SignalDataTypeMap>(
					type: T,
					ids: string[]
				) => {
					const data: { [id: string]: SignalDataTypeMap[T] } = {};

					await Promise.all(
						ids.map(async id => {
							let value = await storage.readData<SignalDataTypeMap[T]>(
								`${type}-${id}.json`
							);

							if (type === 'app-state-sync-key' && value) {
								value = proto.Message.AppStateSyncKeyData.fromObject(
									value
								) as unknown as SignalDataTypeMap[T];
							}

							if (value) {
								data[id] = value;
							}
						})
					);

					return data;
				},
				set: async data => {
					const tasks: Promise<void>[] = [];

					for (const category in data) {
						const typedCategory = category as keyof SignalDataTypeMap;
						const categoryValues = data[typedCategory];

						if (!categoryValues) {
							continue;
						}

						for (const id in categoryValues) {
							const value = categoryValues[id];
							const file = `${typedCategory}-${id}.json`;

							tasks.push(
								value
									? storage.writeData(value, file)
									: storage.removeData(file)
							);
						}
					}

					await Promise.all(tasks);
				},
				clear: async () => {
					await run(db, 'DELETE FROM baileys_auth_state');
				},
			},
		},
		saveCreds: async () => {
			await storage.writeData(creds, 'creds.json');
		},
	};
};
