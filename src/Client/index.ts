import dotenv from 'dotenv';
import NodeCache from 'node-cache';

dotenv.config({
	path: '.env',
});

import makeWASocket, {
	Browsers,
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	proto,
} from 'baileys';
import log from 'baileys/lib/Utils/logger';
import { Boom } from '@hapi/boom';
import {
	getGroupChat,
	getUnreadCount,
	saveGroupChat,
	savePrivateChat,
	updateChatUnreadCount,
} from 'src/Store/ChatStore';
import Context, { setMeFromCreds } from 'src/Context';
import {
	getMessage,
	getOriginalWaMessage,
	messageExists,
	saveMessage,
} from 'src/Store/MessageStore';
import {
	BaileysMessageEvent,
	classifyBaileysMessage,
	createContactPayload,
	createContactFromSync,
	createGroupChatPayload,
	createMessagePayload,
	getMessageContent,
	getPinInChatMessage,
	getPollUpdateMessage,
	handleEditMessage,
	saveLidMappingsFromMessage,
	stringifyMessageId,
} from 'src/PayloadTransformers';
import { MessageReceived } from 'kozz-types';
import createBoundary from 'kozz-boundary-maker';
import { saveContact, saveLidMapping, saveLidMappings } from 'src/Store/ContactStore';
import { updateChatMetadata } from 'src/Store/MetadataStore';
import { getMessagePreview } from 'src/util/utility';
import { groupMemo } from 'src/util/groupMemo';
import { isGroupChatId, isGroupLikeChatId } from 'src/util/chat';
import { useSqliteAuthState } from './SqliteAuthState';

const qrcodeTerminal = require('qrcode-terminal') as {
	generate: (input: string, options?: { small?: boolean }) => void;
};

export type WaSocket = ReturnType<typeof makeWASocket>;

let activeSocket: WaSocket | null = null;
let socketStartPromise: Promise<WaSocket> | null = null;
export const getActiveSocket = () => activeSocket;

let reconnecting = false;
const processingMessageIds = new Set<string>();
const msgRetryCounterCache = new NodeCache({
	stdTTL: 60 * 60,
	useClones: false,
});

console.clear();
console.log('Initializing DB...');

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const GROUP_METADATA_TIMEOUT_MS = 3000;
const DEFAULT_QUERY_TIMEOUT_MS = Number(
	process.env.BAILEYS_DEFAULT_QUERY_TIMEOUT_MS || 180000
);

const withTimeout = async <T>(
	promise: Promise<T>,
	ms: number,
	timeoutMessage: string
): Promise<T> =>
	Promise.race([
		promise,
		wait(ms).then(() => {
			throw new Error(timeoutMessage);
		}),
	]);

const getCachedGroupMetadata = async (jid: string) => {
	const groupChat = await getGroupChat(jid);
	if (!groupChat?.participants?.length) {
		return undefined;
	}

	return {
		id: groupChat.id,
		subject: groupChat.name,
		owner: groupChat.owner,
		desc: groupChat.description,
		size: groupChat.memberCount,
		addressingMode: 'pn' as const,
		linkedParent: groupChat.community ?? undefined,
		participants: groupChat.participants.map(participant => ({
			id: participant.id,
			admin: participant.admin ? ('admin' as const) : null,
		})),
	};
};

export const initSession = (boundary: ReturnType<typeof createBoundary>) => {
	return startSocket(boundary);
};



const startSocket = async (boundary: ReturnType<typeof createBoundary>) => {
	if (activeSocket) {
		return activeSocket;
	}

	if (socketStartPromise) {
		return socketStartPromise;
	}

	socketStartPromise = createSocket(boundary).finally(() => {
		socketStartPromise = null;
	});

	return socketStartPromise;
};

const createSocket = async (boundary: ReturnType<typeof createBoundary>) => {
	const logger = log.child({});
	logger.level = process.env.BAILEYS_LOG_LEVEL || 'fatal';

	console.log('Creating auth...');
	const { state, saveCreds } = await useSqliteAuthState();
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
		defaultQueryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
		msgRetryCounterCache,
		maxMsgRetryCount: 5,
		retryRequestDelayMs: 1000,
		getMessage: getRetryMessage,
		cachedGroupMetadata: getCachedGroupMetadata,
		// syncFullHistory: true,
		logger,
		browser: Browsers.ubuntu('Desktop'),
	});
	activeSocket = waSocket;
	Context.upsert({
		hostData: setMeFromCreds(state.creds),
	});
	activeSocket = waSocket;
	sessionEvents(waSocket, saveCreds, boundary);

	return waSocket;
};

const clearActiveSocket = (waSocket: WaSocket) => {
	if (activeSocket !== waSocket) {
		return;
	}

	waSocket.ev.removeAllListeners('creds.update');
	waSocket.ev.removeAllListeners('connection.update');
	waSocket.ev.removeAllListeners('messaging-history.set');
	waSocket.ev.removeAllListeners('messages.upsert');
	(waSocket.ev as any).removeAllListeners('lid-mapping.update');
	(waSocket.ev as any).removeAllListeners('chats.phoneNumberShare');
	activeSocket = null;
};

const reconnectSocket = async (
	waSocket: WaSocket,
	boundary: ReturnType<typeof createBoundary>
) => {
	if (reconnecting || activeSocket !== waSocket) {
		return;
	}

	reconnecting = true;
	clearActiveSocket(waSocket);

	try {
		await wait(1500);
		await startSocket(boundary);
	} finally {
		reconnecting = false;
	}
};

const getRetryMessage = async (key: proto.IMessageKey) => {
	const candidateIds = [stringifyMessageId(key), key.id].filter(
		(id): id is string => !!id
	);

	for (const messageId of candidateIds) {
		const storedMessage = await getOriginalWaMessage(messageId);
		if (storedMessage?.message) {
			return storedMessage.message;
		}
	}

	return undefined;
};

const logConnectionUpdate = (update: any) => {
	const statusCode = (update.lastDisconnect?.error as Boom | undefined)?.output
		?.statusCode;

	console.log(
		`CONNECTION UPDATED connection=${update.connection ?? 'same'} online=${
			update.isOnline ?? 'unknown'
		} newLogin=${update.isNewLogin ?? 'unknown'} pending=${
			update.receivedPendingNotifications ?? 'unknown'
		} hasQr=${Boolean(update.qr)} statusCode=${statusCode ?? 'none'}`
	);
};

const getLoggedEventType = (event: BaileysMessageEvent) =>
	event.contentType || event.kind;

const refreshGroupMetadata = async (
	waSocket: ReturnType<typeof makeWASocket>,
	chatId?: string | null
) => {
	if (!chatId?.includes('@g.us')) {
		return;
	}

	const groupData = await getGroupData(chatId, waSocket);
	if (groupData) {
		await saveGroupChat(createGroupChatPayload(groupData));
	}
};

const formatLoggedBody = (body: string, messageType: string) => {
	const singleLineBody = body.replace(/\s+/g, ' ').trim();
	if (singleLineBody) {
		return singleLineBody;
	}

	return `<${messageType}>`;
};

const isAiCommandBody = (body: string) => /^[!\/]\s*ai(?:\s|$)/i.test(body.trim());

const getPayloadChatName = async (payload: MessageReceived) => {
	if (payload.chatId.includes('@g.us')) {
		const groupChat = await getGroupChat(payload.chatId);
		return groupChat?.name || payload.chatId;
	}

	return (
		payload.contact.privateName ||
		payload.contact.publicName ||
		payload.contact.id ||
		payload.chatId
	);
};

const getLoggedChatName = async (chatId?: string | null, fallbackName?: string) => {
	if (!chatId) {
		return fallbackName || 'unknown';
	}

	if (chatId.includes('@g.us')) {
		const groupChat = await getGroupChat(chatId);
		return groupChat?.name || chatId;
	}

	return fallbackName || chatId;
};

const handleSystemMessage = async (
	msg: any,
	event: BaileysMessageEvent,
	waSocket: ReturnType<typeof makeWASocket>
) => {
	await saveLidMappingsFromMessage(msg);

	if (event.kind === 'group_update') {
		await refreshGroupMetadata(waSocket, msg.key.remoteJid);
	}

	console.log(`Mensagem ignorada: ${getLoggedEventType(event)}`);
};

const handleProtocolMessage = async (
	msg: any,
	event: BaileysMessageEvent
) => {
	await saveLidMappingsFromMessage(msg);

	if (event.kind === 'protocol_edit') {
		await handleEditMessage(msg);
	}

	console.log(`Mensagem ignorada: ${getLoggedEventType(event)}`);
};

const handleMessageSideEffect = async (
	msg: any,
	event: BaileysMessageEvent,
	waSocket: ReturnType<typeof makeWASocket>,
	boundary: ReturnType<typeof createBoundary>
) => {
	await saveLidMappingsFromMessage(msg);

	if (event.kind === 'reaction') {
		const reaction = event.content?.reactionMessage;
		const contact = await createContactPayload(msg, waSocket);
		boundary.emitForwardableEvent('chat_message_reaction', {
			chatId: reaction?.key?.remoteJid || msg.key.remoteJid,
			messageId: reaction?.key?.id,
			emoji: reaction?.text || '',
			from: contact.id,
			fromHostAccount: contact.isHostAccount,
			timestamp: Date.now(),
			contact,
		});

		const chatName = await getLoggedChatName(msg.key.remoteJid, msg.pushName);
		console.log(
			`React: [${chatName}]: ${reaction?.text || '<removed>'} | ${reaction?.key?.id || 'unknown'}`
		);
		return;
	}

	console.log(`Mensagem ignorada: ${getLoggedEventType(event)}`);
};

const handleUserMessage = async (
	msg: any,
	event: BaileysMessageEvent,
	waSocket: ReturnType<typeof makeWASocket>,
	boundary: ReturnType<typeof createBoundary>,
	shouldEmitMessages: boolean
) => {
	const messageId = msg.key.id;
	if (!messageId) {
		return;
	}

	if (processingMessageIds.has(messageId)) {
		console.log(`[messages.upsert] skipping in-flight duplicate ${messageId}`);
		return;
	}

	if (await messageExists(messageId)) {
		console.log(`[messages.upsert] skipping stored duplicate ${messageId}`);
		return;
	}

	processingMessageIds.add(messageId);

	try {
		await saveLidMappingsFromMessage(msg);
		const messageContent = getMessageContent(msg);
		if (messageContent?.stickerMessage) {
			messageContent.stickerMessage.url = `https://mmg.whatsapp.net${messageContent.stickerMessage.directPath}`;
		}

		const payload = await createMessagePayload(msg, waSocket);

		if (payload.contact.isBlocked) {
			return;
		}

		if (isGroupLikeChatId(payload.chatId)) {
			if (!isGroupChatId(payload.chatId)) {
				await saveGroupChat(createGroupChatPayload({ id: payload.chatId }));
			} else {
				await refreshGroupMetadata(waSocket, payload.chatId);
			}
		} else {
			await savePrivateChat({ id: payload.chatId });
		}

		const chatName = await getPayloadChatName(payload);
		console.log(
			`Mensagem: [${chatName}]: ${formatLoggedBody(payload.body, payload.messageType)} | ${payload.messageType}`
		);
		const isAiCommand = isAiCommandBody(payload.body);
		if (isAiCommand) {
			console.log(
				`[messages.upsert] ai command received messageId=${messageId} chatId=${payload.chatId}`
			);
		}

		await saveMessage(payload, msg);

		if (shouldEmitMessages) {
			boundary.emitMessage(payload);
			boundary.emitForwardableEvent('chat_message_received', payload);
			if (isAiCommand) {
				console.log(
					`[messages.upsert] ai command emitted messageId=${messageId} chatId=${payload.chatId}`
				);
			}
		} else {
			console.log(
				`[messages.upsert] stored ${messageId} without emit for type=append`
			);
		}

		const lastMessagePreview = getMessagePreview(payload);
		const lastMessageTimestamp = new Date().getTime();

		updateChatMetadata({
			id: payload.chatId,
			lastMessagePreview,
			lastMessageTimestamp,
		});

		boundary.emitForwardableEvent('chat_order_move_to_top', payload.chatId);
		if (shouldEmitMessages && !payload.fromHostAccount) {
			const unreadCount = (await getUnreadCount(payload.chatId)) + 1;
			await updateChatUnreadCount(payload.chatId, unreadCount);
			boundary.emitForwardableEvent('chat_unread_increment', {
				chatId: payload.chatId,
				unreadCount,
				lastMessagePreview,
				lastMessageTimestamp,
			});
		}
	} finally {
		processingMessageIds.delete(messageId);
	}
};

const handlePinnedMessage = async (
	msg: any,
	boundary: ReturnType<typeof createBoundary>
) => {
	const pinInChatMessage = getPinInChatMessage(msg);
	if (!pinInChatMessage) {
		return false;
	}

	const chatId = pinInChatMessage.key?.remoteJid || msg.key.remoteJid;
	const pinnedMessageId = pinInChatMessage.key?.id ?? null;
	const isUnpin =
		pinInChatMessage.type === proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL;
	const pinnedMessage =
		!isUnpin && pinnedMessageId ? await getMessage(pinnedMessageId) : null;

	if (chatId) {
		updateChatMetadata({
			id: chatId,
			pinnedMessageId: isUnpin ? null : pinnedMessageId,
		});

		boundary.emitForwardableEvent('chat_pinned_message', {
			chatId,
			messageId: isUnpin ? null : pinnedMessageId,
			message: pinnedMessage,
		});
	}

	return true;
};

const dispatchBaileysMessage = async (
	msg: any,
	waSocket: ReturnType<typeof makeWASocket>,
	boundary: ReturnType<typeof createBoundary>,
	shouldEmitMessages: boolean
) => {
	if (await handlePinnedMessage(msg, boundary)) {
		return;
	}

	if (getPollUpdateMessage(msg)) {
		await saveLidMappingsFromMessage(msg);
		return;
	}

	const event = classifyBaileysMessage(msg);

	switch (event.kind) {
		case 'user_message':
			await handleUserMessage(msg, event, waSocket, boundary, shouldEmitMessages);
			return;
		case 'protocol_edit':
		case 'protocol_revoke':
		case 'protocol':
			await handleProtocolMessage(msg, event);
			return;
		case 'reaction':
		case 'poll_creation':
		case 'poll_update':
			await handleMessageSideEffect(msg, event, waSocket, boundary);
			return;
		case 'group_update':
		case 'system':
			await handleSystemMessage(msg, event, waSocket);
			return;
		case 'empty':
		case 'unsupported':
			await saveLidMappingsFromMessage(msg);
			console.log(`Mensagem ignorada: ${getLoggedEventType(event)}`);
			return;
	}
};

export const getGroupData = async (
	id: string,
	waSocket: ReturnType<typeof makeWASocket>
) => {
	const resp = await groupMemo
		.getData(id, () =>
			withTimeout(
				waSocket.groupMetadata(id),
				GROUP_METADATA_TIMEOUT_MS,
				`groupMetadata timed out for ${id}`
			)
		)
		.catch(err => {
			console.warn(
				`[groupMetadata] refresh skipped id=${id} error=${
					err instanceof Error ? err.message : String(err)
				}`
			);
			return undefined;
		});
	return resp?.data;
};

const sessionEvents = (
	waSocket: ReturnType<typeof makeWASocket>,
	saveCreds: (update?: any) => Promise<void>,
	boundary: ReturnType<typeof createBoundary>
) => {
	waSocket.ev.on('creds.update', (update: any) => {
		saveCreds(update).catch((error: unknown) => {
			console.error('[auth] failed to persist creds.update:', error);
		});
	});

	waSocket.ev.on('connection.update', (update: any) => {
		try {
			if (activeSocket && waSocket !== activeSocket) {
				return;
			}

			logConnectionUpdate(update);

			if (update.qr) {
				console.log('[baileys] QR received. Scan this code to pair:');
				qrcodeTerminal.generate(update.qr, { small: true });
				boundary.emitForwardableEvent('qr_code', update.qr);
				Context.upsert({
					qr: update.qr,
				});
			}

			const { connection, lastDisconnect } = update;

			if (connection === 'open' || update.isOnline) {
				console.log('Connected');
				reconnecting = false;
				boundary.emitForwardableEvent('chat_ready', undefined);
				activeSocket = waSocket;
				Context.upsert({
					ready: true,
					qr: null,
				});
			}

			const loggedOut =
				(lastDisconnect?.error as Boom)?.output?.statusCode ===
				DisconnectReason.loggedOut;

			if (connection === 'close' && loggedOut) {
				Context.upsert({
					ready: false,
					qr: null,
				});
				clearActiveSocket(waSocket);
				return;
			}

			if (connection === 'close' && !loggedOut) {
				Context.upsert({
					ready: false,
					qr: null,
				});

				boundary.emitForwardableEvent('reconnecting', undefined);
				reconnectSocket(waSocket, boundary).catch(error => {
					console.error('[connection] failed to restart socket:', error);
				});
			}
		} catch (e) {
			console.warn(e);
		}
	});

	waSocket.ev.on('messaging-history.set', async (payload: any) => {
		try {
			if (Array.isArray(payload.lidPnMappings)) {
				await saveLidMappings(payload.lidPnMappings);
			}

			for (const msg of payload.messages ?? []) {
				await dispatchBaileysMessage(msg, waSocket, boundary, false);
			}

			for (const contact of payload.contacts ?? []) {
				const payload = await createContactFromSync(contact);
				await saveContact(payload);

				if (payload.isGroup) {
					if (!isGroupChatId(payload.id)) {
						await saveGroupChat(createGroupChatPayload({ id: payload.id }));
						continue;
					}

					const groupData = await getGroupData(payload.id, waSocket);
					if (!groupData) {
						continue;
					}

					await saveGroupChat(createGroupChatPayload(groupData));
				}
			}

			for (const chat of payload.chats ?? []) {
				updateChatUnreadCount(chat.id, chat.unreadCount);
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
		const shouldEmitMessages = !upsert.type || upsert.type === 'notify';

		for (const msg of upsert.messages ?? []) {
			try {
				await dispatchBaileysMessage(msg, waSocket, boundary, shouldEmitMessages);
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
