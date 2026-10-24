import fs from 'fs/promises';
import syncFs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { appPaths } from 'src/InstanceConfig';
import {
	AuthenticationState,
	BufferJSON,
	initAuthCreds,
	proto,
	SignalDataTypeMap,
} from 'baileys';

type AuthRow = {
	key?: string;
	value: string;
};

type SqliteDatabase = sqlite3.Database;

const fixFileName = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-');

const createDatabase = (dbPath: string) => {
	syncFs.mkdirSync(path.dirname(dbPath), { recursive: true });
	return new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
};

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

const close = (db: SqliteDatabase) =>
	new Promise<void>((resolve, reject) => {
		db.close(err => {
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

const all = <T>(db: SqliteDatabase, sql: string, params: unknown[] = []) =>
	new Promise<T[]>((resolve, reject) => {
		db.all(sql, params, (err, rows) => {
			if (err) {
				reject(err);
				return;
			}

			resolve(rows as T[]);
		});
	});

const initAuthDatabase = async (db: SqliteDatabase) => {
	await run(db, 'PRAGMA journal_mode = WAL');
	await run(db, 'PRAGMA synchronous = NORMAL');
	await run(db, 'PRAGMA busy_timeout = 30000');
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
	let queue = Promise.resolve();

	const enqueue = <T>(task: () => Promise<T>) => {
		const result = queue.then(task, task);
		queue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	};

	const normalizeLegacySenderKey = (file: string, value: unknown) => {
		if (!file.startsWith('sender-key-') || !value) {
			return value;
		}

		const raw = Buffer.isBuffer(value) ? value.toString('utf-8') : value;

		if (typeof raw !== 'string') {
			return value;
		}

		try {
			const parsed = JSON.parse(raw, BufferJSON.reviver);
			return Array.isArray(parsed) ? parsed : value;
		} catch {
			return value;
		}
	};

	const writeData = async (data: unknown, file: string) => {
		const serialized = JSON.stringify(data, BufferJSON.replacer);
		await enqueue(() =>
			run(
				db,
				`INSERT INTO baileys_auth_state (key, value, updated_at)
				 VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET
					value = excluded.value,
					updated_at = excluded.updated_at`,
				[storageKey(file), serialized, Date.now()]
			)
		);
	};

	const writeMany = async (entries: { file: string; data: unknown }[]) => {
		if (entries.length === 0) {
			return;
		}

		await enqueue(async () => {
			await run(db, 'BEGIN IMMEDIATE TRANSACTION');

			try {
				const updatedAt = Date.now();

				for (const entry of entries) {
					await run(
						db,
						`INSERT INTO baileys_auth_state (key, value, updated_at)
						 VALUES (?, ?, ?)
						 ON CONFLICT(key) DO UPDATE SET
							value = excluded.value,
							updated_at = excluded.updated_at`,
						[
							storageKey(entry.file),
							JSON.stringify(entry.data, BufferJSON.replacer),
							updatedAt,
						]
					);
				}

				await run(db, 'COMMIT');
			} catch (error) {
				await run(db, 'ROLLBACK').catch(() => undefined);
				throw error;
			}
		});
	};

	const removeMany = async (files: string[]) => {
		if (files.length === 0) {
			return;
		}

		await enqueue(async () => {
			await run(db, 'BEGIN IMMEDIATE TRANSACTION');

			try {
				for (const file of files) {
					await run(db, 'DELETE FROM baileys_auth_state WHERE key = ?', [
						storageKey(file),
					]);
				}

				await run(db, 'COMMIT');
			} catch (error) {
				await run(db, 'ROLLBACK').catch(() => undefined);
				throw error;
			}
		});
	};

	const readData = async <T>(file: string): Promise<T | null> => {
		const row = await enqueue(() =>
			get<AuthRow>(
				db,
				'SELECT value FROM baileys_auth_state WHERE key = ?',
				[storageKey(file)]
			)
		);

		if (!row) {
			return null;
		}

		const value = JSON.parse(row.value, BufferJSON.reviver);

		return normalizeLegacySenderKey(file, value) as T;
	};

	const readMany = async <T>(
		files: string[]
	): Promise<Record<string, T | null>> => {
		const result: Record<string, T | null> = {};

		if (files.length === 0) {
			return result;
		}

		for (const file of files) {
			result[file] = null;
		}

		const keys = files.map(storageKey);
		const placeholders = keys.map(() => '?').join(', ');
		const rows = await enqueue(() =>
			all<AuthRow & { key: string }>(
				db,
				`SELECT key, value FROM baileys_auth_state WHERE key IN (${placeholders})`,
				keys
			)
		);
		const keyToFile = new Map(keys.map((key, index) => [key, files[index]]));

		for (const row of rows) {
			const file = keyToFile.get(row.key);
			if (!file) {
				continue;
			}

			const value = JSON.parse(row.value, BufferJSON.reviver);
			result[file] = normalizeLegacySenderKey(file, value) as T;
		}

		return result;
	};

	const removeData = async (file: string) => {
		await enqueue(() =>
			run(db, 'DELETE FROM baileys_auth_state WHERE key = ?', [
				storageKey(file),
			])
		);
	};

	const hasData = async (file: string) => {
		const row = await enqueue(() =>
			get<{ key: string }>(
				db,
				'SELECT key FROM baileys_auth_state WHERE key = ?',
				[storageKey(file)]
			)
		);

		return Boolean(row);
	};

	return {
		writeData,
		writeMany,
		readData,
		readMany,
		removeData,
		removeMany,
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

export const resetSqliteAuthState = async (
	dbPath = appPaths.authDbPath,
	multiFileAuthDir = appPaths.credsDir
) => {
	const db = createDatabase(dbPath);
	try {
		await initAuthDatabase(db);
		const rows = await all<{ key: string }>(
			db,
			'SELECT key FROM baileys_auth_state'
		);
		await run(db, 'DELETE FROM baileys_auth_state');

		const legacyFiles = await fs.readdir(multiFileAuthDir).catch(() => []);
		const deletedLegacyFiles = await Promise.all(
			legacyFiles
				.filter(file => file.endsWith('.json'))
				.map(async file => {
					await fs.unlink(path.join(multiFileAuthDir, file)).catch(() => undefined);
					return file;
				})
		);

		return {
			sqliteKeysDeleted: rows.length,
			legacyFilesDeleted: deletedLegacyFiles.length,
		};
	} finally {
		await close(db);
	}
};

export const useSqliteAuthState = async (
	dbPath = appPaths.authDbPath,
	multiFileAuthDir = appPaths.credsDir
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
					const files = ids.map(id => `${type}-${id}.json`);
					const values = await storage.readMany<SignalDataTypeMap[T]>(files);

					for (const id of ids) {
						const file = `${type}-${id}.json`;
						let value = values[file];

						if (type === 'app-state-sync-key' && value) {
							value = proto.Message.AppStateSyncKeyData.fromObject(
								value
							) as unknown as SignalDataTypeMap[T];
						}

						if (value) {
							data[id] = value;
						}
					}

					return data;
				},
				set: async data => {
					const writes: { file: string; data: unknown }[] = [];
					const removes: string[] = [];

					for (const category in data) {
						const typedCategory = category as keyof SignalDataTypeMap;
						const categoryValues = data[typedCategory];

						if (!categoryValues) {
							continue;
						}

						for (const id in categoryValues) {
							const value = categoryValues[id];
							const file = `${typedCategory}-${id}.json`;

							if (value) {
								writes.push({ file, data: value });
							} else {
								removes.push(file);
							}
						}
					}

					await storage.writeMany(writes);
					await storage.removeMany(removes);
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
