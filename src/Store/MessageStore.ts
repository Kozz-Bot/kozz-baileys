import { MessageReceived } from 'kozz-types';
import Context from 'src/Context';
import { getMedia, saveMedia } from './MediaStore';
import { getContact, saveContact } from './ContactStore';
import { MessageModel } from './models';
import { proto } from 'baileys';

const database = Context.get('database');

export const saveMessage = async (
	message: MessageReceived,
	originalMessage: proto.IWebMessageInfo
): Promise<string> => {
	database.upsert('message', {
		...message,
		media: message.media ? await saveMedia(message.media) : undefined,
		contact: await saveContact(message.contact),
		timestamp: message.timestamp,
		quotedMessage: message.quotedMessage?.id,
		taggedContacts: JSON.stringify(message.taggedContacts),
		originalMessagePayload: JSON.stringify(originalMessage),
	});

	return message.id;
};

export const getMessage = async (
	id: string
): Promise<(MessageReceived & { originalMessagePayload: string }) | null> => {
	const message: MessageModel | null =
		((await database.getById('message', id)) as MessageModel) ?? null;

	if (!message) {
		return null;
	}

	const contact = await getContact(message.contact);
	if (!contact) {
		return null;
	}

	const media = message.media ? await getMedia(message.media) : undefined;

	return {
		...message,
		taggedContacts: JSON.parse(`[${message.taggedContacts}]`),
		contact: contact,
		quotedMessage: message.quotedMessage
			? (await getMessage(message.quotedMessage)) ?? undefined
			: undefined,

		media,
	};
};

type RecentChatMessagesArgs = {
	chatId: string;
	limit?: number;
	excludeMessageId?: string;
};

export type RecentChatMessage = {
	id: string;
	timestamp: number;
	from: string;
	to: string;
	body: string;
	taggedConctactFriendlyBody: string;
	messageType: MessageReceived['messageType'];
	fromHostAccount: boolean;
	contact: {
		id: string;
		publicName: string;
		isHostAccount: boolean;
	} | null;
	hasMedia: boolean;
};

const normalizeLimit = (limit?: number) => {
	if (!Number.isFinite(limit)) {
		return 200;
	}

	return Math.max(1, Math.min(Math.floor(limit!), 1000));
};

export const getRecentChatMessages = async ({
	chatId,
	limit,
	excludeMessageId,
}: RecentChatMessagesArgs): Promise<RecentChatMessage[]> => {
	const safeLimit = normalizeLimit(limit);
	const query = excludeMessageId ? 'to == $0 AND id != $1' : 'to == $0';
	const queryArgs = excludeMessageId ? [chatId, excludeMessageId] : [chatId];

	const recentMessages = (
		database.getFilteredSorted(
			'message',
			query,
			queryArgs,
			'timestamp',
			'des',
			safeLimit
		) ?? []
	).reverse();

	return Promise.all(
		recentMessages.map(async message => {
			const contact = message.contact ? await getContact(message.contact) : null;

			return {
				id: message.id,
				timestamp: message.timestamp ?? 0,
				from: message.from,
				to: message.to,
				body: message.body,
				taggedConctactFriendlyBody: message.taggedConctactFriendlyBody,
				messageType: message.messageType,
				fromHostAccount: message.fromHostAccount,
				contact: contact
					? {
							id: contact.id,
							publicName: contact.publicName,
							isHostAccount: contact.isHostAccount,
						}
					: null,
				hasMedia: !!message.media,
			};
		})
	);
};
