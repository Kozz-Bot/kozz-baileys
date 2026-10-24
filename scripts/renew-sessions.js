#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sqlite3 = require('sqlite3');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const skipPm2 = args.has('--no-pm2');

const projectRoot = path.resolve(__dirname, '..');

const LEGACY_BOUNDARY_NAME = 'kozz-baileys';
const DEFAULT_NAMESPACE = 'default';

const sanitizePathPart = value => {
	const sanitized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');

	return sanitized || DEFAULT_NAMESPACE;
};

const resolveProjectPath = value =>
	path.isAbsolute(value) ? value : path.resolve(projectRoot, value);

const boundaryName = process.env.BOUNDARY_NAME || LEGACY_BOUNDARY_NAME;
const namespace =
	process.env.KOZZ_NAMESPACE || process.env.NAMESPACE || DEFAULT_NAMESPACE;
const instanceId =
	process.env.BAILEYS_INSTANCE_ID ||
	process.env.KOZZ_INSTANCE_ID ||
	`${namespace}-${boundaryName}`;
const useLegacyPaths =
	!process.env.BAILEYS_INSTANCE_ID &&
	!process.env.KOZZ_INSTANCE_ID &&
	namespace === DEFAULT_NAMESPACE &&
	boundaryName === LEGACY_BOUNDARY_NAME;
const instanceRoot = resolveProjectPath(
	process.env.BAILEYS_INSTANCE_DIR ||
		process.env.KOZZ_INSTANCE_DIR ||
		(useLegacyPaths ? '.' : path.join('instances', sanitizePathPart(instanceId)))
);
const dbPath = resolveProjectPath(
	process.env.BAILEYS_AUTH_DB_PATH ||
		path.join(instanceRoot, 'baileys-auth.sqlite')
);
const pm2ProcessName = process.env.BAILEYS_PM2_PROCESS || 'kozz-baileys';

const runSql = (db, sql, params = []) =>
	new Promise((resolve, reject) => {
		db.run(sql, params, function onRun(err) {
			if (err) {
				reject(err);
				return;
			}

			resolve(this.changes || 0);
		});
	});

const getSql = (db, sql, params = []) =>
	new Promise((resolve, reject) => {
		db.get(sql, params, (err, row) => {
			if (err) {
				reject(err);
				return;
			}

			resolve(row);
		});
	});

const closeDb = db =>
	new Promise((resolve, reject) => {
		db.close(err => {
			if (err) {
				reject(err);
				return;
			}

			resolve();
		});
	});

const runPm2 = action => {
	if (skipPm2) {
		return;
	}

	if (dryRun) {
		console.log(`[dry-run] pm2 ${action} ${pm2ProcessName}`);
		return;
	}

	execFileSync('pm2', [action, pm2ProcessName], {
		stdio: 'inherit',
		cwd: projectRoot,
	});
};

const backupDatabase = () => {
	if (!fs.existsSync(dbPath)) {
		throw new Error(`SQLite auth DB not found: ${dbPath}`);
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupDir = path.join(projectRoot, 'auth-backups', `renew-sessions-${stamp}`);
	const backupPath = path.join(backupDir, path.basename(dbPath));

	if (dryRun) {
		console.log(`[dry-run] backup ${dbPath} -> ${backupPath}`);
		return backupPath;
	}

	fs.mkdirSync(backupDir, { recursive: true });
	fs.copyFileSync(dbPath, backupPath);

	for (const suffix of ['-wal', '-shm']) {
		const sidecar = `${dbPath}${suffix}`;
		if (fs.existsSync(sidecar)) {
			fs.copyFileSync(sidecar, `${backupPath}${suffix}`);
		}
	}

	return backupPath;
};

const renewSqliteSessions = async () => {
	if (dryRun) {
		const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
		try {
			const session = await getSql(
				db,
				"SELECT COUNT(*) AS count FROM baileys_auth_state WHERE key LIKE 'session-%'"
			);
			const sender = await getSql(
				db,
				"SELECT COUNT(*) AS count FROM baileys_auth_state WHERE key LIKE 'sender-key-%'"
			);
			console.log(
				`[dry-run] would delete ${session?.count || 0} sessions and ${sender?.count || 0} sender keys`
			);
			return { sessionsDeleted: 0, senderKeysDeleted: 0 };
		} finally {
			await closeDb(db);
		}
	}

	const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE);
	try {
		await runSql(db, 'PRAGMA busy_timeout = 5000');

		const sessionsDeleted = await runSql(
			db,
			"DELETE FROM baileys_auth_state WHERE key LIKE 'session-%'"
		);
		const senderKeysDeleted = await runSql(
			db,
			"DELETE FROM baileys_auth_state WHERE key LIKE 'sender-key-%'"
		);

		await runSql(db, 'PRAGMA wal_checkpoint(TRUNCATE)').catch(() => undefined);

		return { sessionsDeleted, senderKeysDeleted };
	} finally {
		await closeDb(db);
	}
};

const main = async () => {
	console.log('[renew-sessions] Renewing Baileys Signal sessions...');
	console.log(`[renew-sessions] SQLite DB: ${dbPath}`);

	runPm2('stop');

	const backupPath = backupDatabase();
	const result = await renewSqliteSessions();

	console.log(`[renew-sessions] Backup: ${backupPath}`);
	console.log(
		`[renew-sessions] Deleted ${result.sessionsDeleted} session keys and ${result.senderKeysDeleted} sender keys.`
	);

	runPm2('restart');

	console.log('[renew-sessions] Done. Pairing credentials were preserved.');
};

main().catch(error => {
	console.error('[renew-sessions] Failed:', error);
	process.exit(1);
});
