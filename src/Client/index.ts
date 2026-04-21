import dotenv from 'dotenv';

dotenv.config({
	path: '.env',
});

import makeWASocket, {
	Browsers,
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
} from 'baileys';
import log from 'baileys/lib/Utils/logger';
import { Boom } from '@hapi/boom';
import {
	saveGroupChat,
	savePrivateChat,
	updateChatUnreadCount,
} from 'src/Store/ChatStore';
import Context, { setMeFromCreds } from 'src/Context';
import { saveMessage } from 'src/Store/MessageStore';
import {
	createContactFromSync,
	createGroupChatPayload,
	createMessagePayload,
} from 'src/PayloadTransformers';
import createBoundary from 'kozz-boundary-maker';
import { saveContact, saveLidMapping } from 'src/Store/ContactStore';
import { updateChatMetadata } from 'src/Store/MetadataStore';
import { getMessagePreview } from 'src/util/utility';
import { groupMemo } from 'src/util/groupMemo';
import qrCode from 'qrcode';

export type WaSocket = ReturnType<typeof makeWASocket>;

console.clear();
console.log('Initializing DB...');

export const initSession = (boundary: ReturnType<typeof createBoundary>) => {
	return startSocket(boundary);
};

const startSocket = async (boundary: ReturnType<typeof createBoundary>) => {
	const logger = log.child({});
	logger.level = 'error';

	console.log('Creating auth...');
	const { state, saveCreds } = await useMultiFileAuthState('./creds');
	console.log('Done');
	const { version, isLatest } = await fetchLatestBaileysVersion();
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

	const waSocket = makeWASocket({
		version,
		// This option is deprecated!
		// printQRInTerminal: true,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		generateHighQualityLinkPreview: true,
		// syncFullHistory: true,
		logger,
		browser: Browsers.ubuntu('Desktop'),
	});
	setMeFromCreds();
	sessionEvents(waSocket, saveCreds, boundary);

	return waSocket;
};

export const getGroupData = async (
	id: string,
	waSocket: ReturnType<typeof makeWASocket>
) => {
	const resp = await groupMemo
		.getData(id, () => waSocket.groupMetadata(id))
		.catch(err => undefined);
	return resp?.data;
};

const sessionEvents = (
	waSocket: ReturnType<typeof makeWASocket>,
	saveCreds: any,
	boundary: ReturnType<typeof createBoundary>
) => {
	waSocket.ev.on('creds.update', () => {
		saveCreds();
	});

	waSocket.ev.on('connection.update', (update: any) => {
		try {
			console.log('CONNECTION UPDATED =>', update);

			if (update.qr) {
				boundary.emitForwardableEvent('kozz-iwac', 'qr_code');
				Context.upsert({
					qr: update.qr,
				});

				console.log(
					qrCode.toString(update.qr, { type: 'terminal' }).then(console.log)
				);
			}

			const { connection, lastDisconnect } = update;

			if (connection === 'open' || update.isOnline) {
				console.log('Connected');
				boundary.emitForwardableEvent('kozz-iwac', 'chat_ready');
				Context.upsert({
					ready: true,
					qr: null,
				});
			}

			const loggedOut =
				(lastDisconnect?.error as Boom)?.output?.statusCode ===
				DisconnectReason.loggedOut;

			if (connection === 'close' && !loggedOut) {
				Context.upsert({
					ready: false,
					qr: null,
				});

				boundary.emitForwardableEvent('kozz-iwac', 'reconnecting');
				startSocket(boundary);
			}
		} catch (e) {
			console.warn(e);
		}
	});

	waSocket.ev.on('messaging-history.set', (payload: any) => {
		try {
			payload.messages.forEach(async (msg: any) => {
				const payload = await createMessagePayload(msg, waSocket);
				await saveMessage(payload, msg);
			});

			payload.contacts.forEach(async (contact: any) => {
				const payload = await createContactFromSync(contact);
				await saveContact(payload);

				if (payload.isGroup) {
					const groupData = getGroupData(payload.id, waSocket);
					// if (!groupData) {
					// 	return;
					// }
					await saveGroupChat(createGroupChatPayload(groupData));
				}
			});

			payload.chats.forEach(async (chat: any) => {
				updateChatUnreadCount(chat.id, chat.unreadCount);
			});

			// Persist LID ↔ PN mappings that arrive during history sync
			if (Array.isArray(payload.lidPnMappings)) {
				payload.lidPnMappings.forEach(async ({ pn, lid }: { pn: string; lid: string }) => {
					if (pn && lid) {
						await saveLidMapping(pn, lid);
					}
				});
			}
		} catch (e) {
			console.warn(e);
		}
	});

	// Persist incremental LID ↔ PN mappings pushed by WhatsApp at runtime.
	// Cast to `any` because the installed baileys version doesn't declare this
	// event in its BaileysEventMap yet, but it is emitted at runtime.
	(waSocket.ev as any).on('lid-mapping.update', async (mapping: any) => {
		try {
			const { pn, lid } = mapping;
			if (pn && lid) {
				await saveLidMapping(pn, lid);
				console.log(`[LID] Mapped lid=${lid} → pn=${pn}`);
			}
		} catch (e) {
			console.warn('[LID] lid-mapping.update error:', e);
		}
	});

	// WhatsApp pushes LID→PN mapping when a user shares their phone number
	// (e.g. after a group message from a LID-only contact).
	// This is the primary real-time source of LID↔PN resolution.
	waSocket.ev.on('chats.phoneNumberShare' as any, async ({ lid, jid }: { lid: string; jid: string }) => {
		try {
			if (lid && jid) {
				await saveLidMapping(jid, lid);
				console.log(`[LID] chats.phoneNumberShare: lid=${lid} → pn=${jid}`);
			}
		} catch (e) {
			console.warn('[LID] chats.phoneNumberShare error:', e);
		}
	});

	waSocket.ev.on('messages.upsert', async (upsert: any) => {
		for (const msg of upsert.messages) {
			console.log(`processando mensagem ${msg.key.id}`);
			if (msg.message?.stickerMessage) {
				msg.message.stickerMessage.url = `https://mmg.whatsapp.net${msg.message.stickerMessage.directPath}`;
			}

			try {
				const payload = await createMessagePayload(msg, waSocket);

				if (payload.contact.isBlocked) {
					return;
				}

				if (payload.chatId.includes('@g.us')) {
					const chatMetadata = await getGroupData(payload.chatId, waSocket);
					await saveGroupChat(createGroupChatPayload(chatMetadata));
				} else {
					savePrivateChat({ id: payload.chatId });
				}

				await saveMessage(payload, msg);
				boundary.emitMessage(payload);

				updateChatMetadata({
					id: payload.chatId,
					lastMessagePreview: getMessagePreview(payload),
					lastMessageTimestamp: new Date().getTime(),
				});

				boundary.emitForwardableEvent('chat_order_move_to_top', payload.chatId);
			} catch (e) {
				console.warn(e);
			}
		}
	});

	// waSocket.ev.on('chats.update', async (payload: any) => {
	// 	try {
	// 		console.log('CHAT UPDATED!!! => \n', JSON.stringify(payload, undefined, '  '));

	// 		// [TODO]: create types for all of this
	// 		payload.forEach((chat: any) => {
	// 			const id = chat.id;
	// 			const unreadCount = chat.unreadCount;
	// 			updateChatMetadata({
	// 				id,
	// 				unreadCount,
	// 			});
	// 		});
	// 	} catch (e) {
	// 		console.warn(e);
	// 	}
	// });
};
