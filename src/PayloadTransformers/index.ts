import { WAMessage, WASocket, proto } from 'baileys';
import { ContactPayload, GroupChat, MessageReceived } from 'kozz-types';
import Context from 'src/Context';
import { getContact, resolveJidFromLid } from 'src/Store/ContactStore';
import { getMessage, saveMessage } from 'src/Store/MessageStore';
import { GroupChatModel } from 'src/Store/models';
import { downloadMediaFromMessage } from 'src/util/media';
import { clearContact, replaceTaggedName } from 'src/util/utility';

export const stringifyMessageId = (messageKey: proto.IMessageKey): string => {
	const { fromMe, remoteJid, id, participant } = messageKey;
	if (participant) {
		return `${remoteJid}_${id}_${participant}`;
	} else {
		return `${remoteJid}_${id}`;
	}
};

export const serializeMessageId = (messageId: string): proto.IMessageKey => {
	const [remoteJid, id, participant] = messageId.split('_');
	return {
		id,
		participant,
		remoteJid,
	};
};

export const createContactPayload = async (
	message: WAMessage,
	waSocket?: WASocket
): Promise<ContactPayload> => {
	const getContactId = (message: WAMessage) => {
		if (message.key.fromMe) {
			return Context.get('hostData').id;
		}
		return message.key.participant || message.participant || message.key.remoteJid!;
	};

	let contactId = clearContact(getContactId(message));
	const isBlocked = Context.get('blockedList').includes(message.key.participant!);

	// If the JID is in LID format, resolve it to a phone-number JID via DB mapping
	if (contactId.endsWith('@lid')) {
		const resolvedPn = await resolveJidFromLid(contactId);
		if (resolvedPn) {
			contactId = resolvedPn;
		} else {
			console.warn(`[LID] Could not resolve LID ${contactId} to a phone-number JID (mapping not yet known)`);
		}
	}

	return {
		hostAdded: false,
		id: contactId,
		isHostAccount: !!message.key.fromMe,
		isBlocked,
		publicName: message.pushName || '',
		isGroup: message.key.participant ? true : false,
		privateName: '',
	};
};

export const createContactFromSync = async (contact: {
	id: string;
	name: string;
}) => {
	const hostData = Context.get('hostData');
	const isBlocked = Context.get('blockedList').includes(contact.id);

	return {
		hostAdded: false,
		id: contact.id,
		isHostAccount: hostData.id === contact.id,
		isBlocked,
		publicName: contact.name || 'no_name',
		isGroup: contact.id.includes('@g.us'),
		privateName: '',
	};
};

export const createtTaggedContactPayload = async (
	message: WAMessage
): Promise<ContactPayload[]> => {
	let contacts: ContactPayload[] = [];
	if (message.message?.extendedTextMessage?.contextInfo?.mentionedJid) {
		for (const contactId of message.message?.extendedTextMessage?.contextInfo
			?.mentionedJid) {
			const contact = await getContact(contactId);
			if (contact) {
				contacts.push(contact);
			}
		}
	}

	return contacts;
};

export const handleEditMessage = async (message: WAMessage) => {
	if (
		message.message?.protocolMessage?.type ==
		proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
	) {
		const editedId = message.message?.protocolMessage?.key?.id!;
		let editedMsg = await getMessage(editedId);

		if (editedMsg) {
			const editedMessageBody =
				message.message?.protocolMessage?.editedMessage?.conversation ||
				message.message?.protocolMessage?.editedMessage?.extendedTextMessage?.text ||
				message.message?.protocolMessage?.editedMessage?.imageMessage?.caption ||
				message.message?.protocolMessage?.editedMessage?.videoMessage?.caption ||
				'';
			editedMsg.body = editedMessageBody;

			editedMsg.santizedBody = editedMessageBody
				.toLowerCase()
				.normalize('NFKD')
				.replace(/[\u0300-\u036f]/g, '');

			const editedTaggedContact = await createtTaggedContactPayload(message);
			editedMsg.taggedContacts = editedTaggedContact;

			let editedTaggedConctactFriendlyBody = editedMessageBody;
			if (editedTaggedContact.length) {
				editedTaggedConctactFriendlyBody = replaceTaggedName(
					editedMessageBody,
					editedTaggedContact
				);
			}
			editedMsg.taggedConctactFriendlyBody = editedTaggedConctactFriendlyBody;
			editedMsg.id = `${editedMsg.id}_edited${new Date().getTime()}`;

			await saveMessage(editedMsg, message);
		}
	}
};

export const createMessagePayload = async (
	message: WAMessage,
	waSocket: WASocket
): Promise<MessageReceived> => {
	handleEditMessage(message); // check if is edit message

	const media = await downloadMediaFromMessage(message, waSocket);
	const contact = await createContactPayload(message, waSocket);
	const taggedContact = await createtTaggedContactPayload(message);

	const messageBody =
		message.message?.conversation ||
		message.message?.extendedTextMessage?.text ||
		message?.message?.imageMessage?.caption ||
		message?.message?.videoMessage?.caption ||
		message?.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
		'';

	let taggedConctactFriendlyBody = messageBody;
	if (taggedContact.length) {
		taggedConctactFriendlyBody = replaceTaggedName(messageBody, taggedContact);
	}
	const messageType = message.message?.extendedTextMessage
		? 'TEXT'
		: message.message?.audioMessage
			? 'AUDIO'
			: message.message?.stickerMessage
				? 'STICKER'
				: message.message?.videoMessage
					? 'VIDEO'
					: message.message?.imageMessage
						? 'IMAGE'
						: 'TEXT';

	const contextInfo = (
		message.message?.extendedTextMessage ||
		message.message?.audioMessage ||
		message.message?.stickerMessage ||
		message.message?.videoMessage ||
		message.message?.imageMessage
	)?.contextInfo!;

	const id = message.key.id!;
	const quotedMessageId = contextInfo?.stanzaId!;

	const quotedMessage = quotedMessageId
		? await getMessage(quotedMessageId)
		: undefined;

	if (messageBody.toLowerCase() === 'teste') {
		console.log({ id, quotedMessageId, quotedMessage });
	}

	if (quotedMessageId && quotedMessage) {
		const quoteMessage = {
			key: {
				remoteJid: message?.key?.remoteJid,
				fromMe: message?.key?.fromMe,
				id: quotedMessageId,
				participant: message?.key?.participant,
			},
			message: contextInfo?.quotedMessage,
		};
		const mediaQuote = await downloadMediaFromMessage(quoteMessage, waSocket);

		if (mediaQuote) {
			quotedMessage.media = mediaQuote;
			quotedMessage.messageType = contextInfo?.quotedMessage?.extendedTextMessage
				? 'TEXT'
				: contextInfo?.quotedMessage?.audioMessage
					? 'AUDIO'
					: contextInfo?.quotedMessage?.stickerMessage
						? 'STICKER'
						: contextInfo?.quotedMessage?.videoMessage
							? 'VIDEO'
							: contextInfo?.quotedMessage?.imageMessage
								? 'IMAGE'
								: 'TEXT';

			quotedMessage.isViewOnce =
				(
					contextInfo?.quotedMessage?.audioMessage ||
					contextInfo?.quotedMessage?.videoMessage ||
					contextInfo?.quotedMessage?.imageMessage
				)?.viewOnce || false;

			quotedMessage.taggedConctactFriendlyBody =
				(
					contextInfo?.quotedMessage?.videoMessage ||
					contextInfo?.quotedMessage?.imageMessage
				)?.caption || '';

			await saveMessage(quotedMessage, quotedMessage.originalMessagePayload as any);
		}
	}

	return {
		body: messageBody,
		boundaryName: process.env.BOUNDARY_NAME ?? '',
		id,
		contact: await createContactPayload(message, waSocket),
		from: contact.id,
		fromHostAccount: contact.isHostAccount,
		isViewOnce: false,
		to: message.key.remoteJid!,
		chatId: message.key.remoteJid!.includes('@g.us')
			? message.key.remoteJid!
			: contact.id,
		messageType: messageType,
		platform: 'Baileys',
		quotedMessage: quotedMessage || undefined,
		santizedBody: messageBody
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, ''),
		taggedContacts: taggedContact,
		timestamp:
			new Date(Number(message.messageTimestamp)).getTime() || new Date().getTime(),
		taggedConctactFriendlyBody: taggedConctactFriendlyBody,
		media,
	};
};

export const createGroupChatPayload = (
	ogChatPayload: any
): GroupChat & {
	lastMessageTimestamp: number;
} => {
	return {
		id: ogChatPayload.id,
		community: ogChatPayload.linkedParent ?? null,
		description: ogChatPayload.desc ?? '',
		memberCount: ogChatPayload.size!,
		name: ogChatPayload.subject,
		owner:
			ogChatPayload.owner ??
			ogChatPayload.participants?.find(
				(participant: any) => participant.admin === 'superadmin'
			)?.id ??
			'NOT_FOUND',
		participants: ogChatPayload.participants?.map((participant: any) => ({
			admin: !!participant.admin,
			id: participant.id,
		})),
		unreadCount: ogChatPayload.unreadCount ?? 0,
		lastMessageTimestamp: ogChatPayload.lastMessageTimestamp ?? 0,
	};
};
