import { WaSocket } from 'src/Client';
import context from '../Context';
import { Boom } from '@hapi/boom';
import { DisconnectReason } from 'baileys';

export const onReady = (waSocket: WaSocket, cb: () => any) => {
	waSocket.ev.on('connection.update', conn => {
		if (conn.connection === 'open') {
			cb();
		}
	});
};

export const syncBlockedList = (waSocket: WaSocket) => {
	onReady(waSocket, async () => {
		const blockedList = (await waSocket.fetchBlocklist()).filter((x): x is string => x !== undefined);
		context.upsert({
			blockedList,
		});
	});
};

export const reconnectWhenFail = (waSocket: WaSocket, initFn: () => any) => {
	waSocket.ev.on('connection.update', update => {
		const { connection, lastDisconnect } = update;

		if (connection === 'close') {
			const shouldReconnect =
				(lastDisconnect?.error as Boom)?.output?.statusCode !==
				DisconnectReason.loggedOut;

			// reconnect if not logged out
			if (shouldReconnect) {
				initFn();
			}
		} else if (connection === 'open') {
			context.upsert({
				ready: true,
			});
		}
	});
};
