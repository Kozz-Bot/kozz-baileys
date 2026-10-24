import { WaSocket } from '.';
import {
	AnyMessageContent,
	proto,
} from 'baileys';
import { ContactPayload, Media } from 'kozz-types';
import context from '../Context';
import { downloadBuffer } from 'src/util/downloadBuffer';
import { convertJpegToWebp, convertMP4ToWebp } from 'src/MediaConverter';
import { getMessage } from 'src/Store/MessageStore';
import {
	getContactByLid,
	resolveLidFromJid,
	saveLidMapping,
} from 'src/Store/ContactStore';
import {
	generateHash,
	getFormattedDateAndTime,
	getVisibleContactMention,
} from 'src/util/utility';
import {
	CompanionObject,
	InlineCommandMap,
	StyleVariant,
} from 'kozz-boundary-maker/dist/InlineCommand';
import { getGroupChat } from 'src/Store/ChatStore';
const webp = require('node-webpmux'); // import has type error.

const database = context.get('database');
const PN_DOMAIN = '@s.whatsapp.net';
const LID_DOMAIN = '@lid';
const GROUP_DOMAIN = '@g.us';

type OnWhatsAppResult = {
	jid?: string;
	lid?: string;
	exists?: boolean;
};

const normalizePnJid = (jid: string) => {
	if (jid.includes('@')) {
		return jid;
	}

	return `${jid}${PN_DOMAIN}`;
};

const getOGQuotedMessagePayload = (messageId?: string) => {
	if (!messageId) {
		return undefined;
	}

	const originalMessagePayload = database.getById(
		'message',
		messageId
	)?.originalMessagePayload;

	const response = originalMessagePayload
		? JSON.parse(originalMessagePayload)
		: undefined;

	return response;
};

const sendOptions = (targetId: string, quotedMessageId?: string) => ({
	quoted: getOGQuotedMessagePayload(quotedMessageId),
	useCachedGroupMetadata: targetId.endsWith(GROUP_DOMAIN),
});

const baileysFunctions = (clientOrGetter: WaSocket | (() => WaSocket | null)) => {
	const getClient = () => {
		const client =
			typeof clientOrGetter === 'function' ? clientOrGetter() : clientOrGetter;

		if (!client) {
			throw new Error('Baileys socket is not connected');
		}

		return client;
	};

	const checkNumber = async (id: string) => {
		const client = getClient();
		const result = (await client.onWhatsApp(
			normalizePnJid(id)
		)) as OnWhatsAppResult[] | undefined;
		const match = result?.[0];
		if (match?.jid && match?.lid) {
			await saveLidMapping(match.jid, match.lid);
		}

		return match?.exists;
	};

	const resolveSendTarget = async (receiverId: string): Promise<string> => {
		const client = getClient();

		if (
			!receiverId ||
			receiverId.endsWith(GROUP_DOMAIN) ||
			receiverId.endsWith(LID_DOMAIN)
		) {
			return receiverId;
		}

		const pnJid = normalizePnJid(receiverId);
		if (!pnJid.endsWith(PN_DOMAIN)) {
			return receiverId;
		}

		const knownLid = await resolveLidFromJid(pnJid);
		if (knownLid) {
			return knownLid;
		}

		try {
			const result = (await client.onWhatsApp(
				pnJid
			)) as OnWhatsAppResult[] | undefined;
			const match = result?.find(contact => contact.exists);
			if (match?.jid && match?.lid) {
				await saveLidMapping(match.jid, match.lid);
				return match.lid;
			}

			return match?.jid ?? receiverId;
		} catch (e) {
			console.warn(
				`[LID] Could not resolve send target receiverId=${receiverId} error=${
					e instanceof Error ? e.message : String(e)
				}`
			);
			return receiverId;
		}
	};

	const sendText = async (
		receiverId: string,
		text: string,
		quotedMessageId?: string,
		tagged?: string[]
	) => {
		try {
			const targetId = await resolveSendTarget(receiverId);
			const client = getClient();
			return await client.sendMessage(
				targetId,
				{
					text,
					mentions: tagged,
				},
				sendOptions(targetId, quotedMessageId)
			);
		} catch (e) {
			console.warn('[Baileys] sendText failed:', e);
			return undefined;
		}
	};

	const sendMedia = async (
		contactId: string,
		media: Media,
		options: {
			viewOnce?: boolean;
			caption?: string;
			mentionedList?: string[];
			asSticker?: boolean;
			asVoiceNote?: boolean;
			contact?: ContactPayload;
			emojis?: string[];
		},
		quoteId?: string
	) => {
		try {
			const targetId = await resolveSendTarget(contactId);
			const client = getClient();
			const sendMediaOptions: Partial<AnyMessageContent> = {
				viewOnce: options?.viewOnce,
				mentions: options?.mentionedList ?? [],
				caption: options?.caption,
			};

			let mediaData =
				media.transportType === 'b64'
					? Buffer.from(media.data, 'base64url')
					: await downloadBuffer(media.data);

			if (options?.asSticker) {
				let isAnimated = false;
				if (media.mimeType === 'video/mp4') {
					isAnimated = true;
					mediaData =
						(await convertMP4ToWebp(mediaData.toString('base64url'))) ?? mediaData;
				} else {
					mediaData = (await convertJpegToWebp(media.data)) ?? mediaData;
				}
				const emoji = options?.emojis || [''];
				const metadata = {
					name: `Criado por ${options?.contact?.publicName
						}\n${getFormattedDateAndTime()}\n${emoji[0] || ''}`,
					author: '\nKozz-Bot\ndo Tramonta',
				};
				const img = new webp.Image();
				const stickerPackId = generateHash(32);
				const packname = metadata.name;
				const author = metadata.author;
				const emojis = emoji;
				const json = {
					'sticker-pack-id': stickerPackId,
					'sticker-pack-name': packname,
					'sticker-pack-publisher': author,
					emojis: emojis,
				};
				let exifAttr = Buffer.from([
					0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07,
					0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
				]);
				let jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
				// @ts-ignore
				let exif = Buffer.concat([exifAttr, jsonBuffer]);
				exif.writeUIntLE(jsonBuffer.length, 14, 4);
				await img.load(Buffer.from(mediaData as any, 'base64'));
				img.exif = exif;
				mediaData = await img.save(null);

				try {
					return await client.sendMessage(
						targetId,
						{
							...sendMediaOptions,
							sticker: mediaData,
							isAnimated: isAnimated,
						},
						sendOptions(targetId, quoteId)
					);
				} catch (e) {
					return undefined;
				}
			}

			if (media.mimeType.startsWith('audio')) {
				try {
					return await client.sendMessage(
						targetId,
						{
							...sendMediaOptions,
							audio: mediaData,
							ptt: options?.asVoiceNote,
							mimetype: 'audio/mp4',
						},
						sendOptions(targetId, quoteId)
					);
				} catch (e) {
					return undefined;
				}
			}

			if (media.mimeType.startsWith('image')) {
				try {
					return await client.sendMessage(
						targetId,
						{
							...sendMediaOptions,
							image: mediaData,
						},
						sendOptions(targetId, quoteId)
					);
				} catch (e) {
					return undefined;
				}
			}

			if (media.mimeType.startsWith('video')) {
				try {
					return await client.sendMessage(
						targetId,
						{
							...sendMediaOptions,
							video: mediaData,
						},
						sendOptions(targetId, quoteId)
					);
				} catch (e) {
					return undefined;
				}
			}
			try {
				return await client.sendMessage(
					targetId,
					{
						...sendMediaOptions,
						text: '',
						document: mediaData,
					},
					sendOptions(targetId, quoteId)
				);
			} catch (e) {
				return undefined;
			}
		} catch (e) {
			console.warn('[Baileys] sendMedia failed:', e);
			return undefined;
		}
	};

	const reactMessage = async (messageId: string, emoji: string) => {
		try {
			const client = getClient();
			const ogMessage = await getMessage(messageId);
			if (!ogMessage) {
				return;
			}

			const ogPayload = JSON.parse(
				ogMessage.originalMessagePayload
			) as proto.IWebMessageInfo;

			return await client.sendMessage(
				ogPayload.key.remoteJid!,
				{
					react: {
						key: ogPayload.key,
						text: emoji,
					},
				},
				sendOptions(ogPayload.key.remoteJid!)
			);
		} catch (e) {
			console.warn('[Baileys] reactMessage failed:', e);
			return undefined;
		}
	};

	const getProfilePic = async (
		contactId: string,
		type: 'preview' | 'image' = 'preview'
	) => {
		try {
			const client = getClient();
			const profilePic = await client.profilePictureUrl(contactId, type, 10000);
			return profilePic;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);

			if (
				message.includes('rate-overlimit') ||
				message.includes('Connection Closed')
			) {
				return undefined;
			}

			console.warn(`[ProfilePic] Unable to fetch profile picture for ${contactId}: ${message}`);
			return undefined;
		}
	};

	const deleteMessage = async (messageId: string) => {
		try {
			const client = getClient();
			const ogMessage = await getMessage(messageId);
			if (!ogMessage) {
				return;
			}

			const ogPayload = JSON.parse(
				ogMessage.originalMessagePayload
			) as proto.IWebMessageInfo;

			const response = await client.sendMessage(
				ogPayload.key.remoteJid!,
				{
					delete: ogPayload.key,
				},
				sendOptions(ogPayload.key.remoteJid!)
			);
			return response;
		} catch (e) {
			console.warn(e);
			return undefined;
		}
	};

	const readMessages = async (messageIds: string[]) => {
		try {
			const client = getClient();
			const messages = await Promise.all(messageIds.map(messageId => getMessage(messageId)));
			const messageKeys = messages
				.filter(Boolean)
				.map(message => {
					const originalPayload = JSON.parse(
						message!.originalMessagePayload
					) as proto.IWebMessageInfo;
					return originalPayload.key;
				})
				.filter(messageKey => messageKey.remoteJid && messageKey.id);

			if (!messageKeys.length) {
				return {
					read: 0,
				};
			}

			await client.readMessages(messageKeys);

			return {
				read: messageKeys.length,
			};
		} catch (e) {
			console.warn('[Baileys] readMessages failed:', e);
			return {
				read: 0,
			};
		}
	};

	/**
	 * Looks up a contact by its LID (@lid JID).
	 * Returns the full ContactModel (including phone-number `id`) or null.
	 */
	const getContactFromLid = async (lid: string) => {
		return getContactByLid(lid);
	};

	return {
		checkNumber,
		sendMedia,
		sendText,
		reactMessage,
		getProfilePic,
		deleteMessage,
		readMessages,
		getContactFromLid,
	};
};

const getMarkdownFor = (variant: StyleVariant, position: 'begin' | 'end') => {
	const markdownMap: Record<'begin' | 'end', Record<StyleVariant, string>> = {
		begin: {
			bold: '*',
			code: '```',
			italic: '_',
			listItem: '- ',
			monospace: '`',
			paragraph: '> ',
			stroke: '~',
		},
		end: {
			bold: '*',
			code: '```',
			italic: '_',
			listItem: '',
			monospace: '`',
			paragraph: '',
			stroke: '~',
		},
	};

	return markdownMap[position][variant];
};

const sanitizeTableCell = (value: unknown) => {
	return String(value ?? '')
		.replace(/\r?\n/g, ' ')
		.replace(/\t/g, '    ');
};

const stringifyTableRow = (cells: unknown[]) => {
	return cells.map(sanitizeTableCell).join('\t');
};

export const inlineCommandMapFunctions = (): Partial<InlineCommandMap> => {
	const mention = async (
		companion: CompanionObject,
		data: { id: string },
		payload: any
	) => {
		return {
			companion: {
				mentions: [...companion.mentions, data.id],
			},
			stringValue: getVisibleContactMention(data.id),
		};
	};

	const invisiblemention = async (
		companion: CompanionObject,
		data: { id: string },
		payload: any
	) => {
		return {
			companion: {
				mentions: [...companion.mentions, data.id],
			},
			stringValue: '',
		};
	};
	const tageveryone = async (
		companion: CompanionObject,
		data: { except: string[] },
		payload: any
	) => {
		let mentions: string[] = [];

		const chatInfo = await getGroupChat(payload.chatId);

		if (chatInfo) {
			mentions = chatInfo.participants
				.map(member => member.id)
				.filter(member => !data.except.includes(member));
		}

		return {
			companion: {
				mentions: [...companion.mentions, ...mentions],
			},
			stringValue: '',
		};
	};

	const begin_style = async (
		companion: CompanionObject,
		data: { variant: StyleVariant },
		payload: any
	) => {
		const stringValue = getMarkdownFor(data.variant, 'begin');

		return {
			companion: {
				mentions: [...companion.mentions],
			},
			stringValue,
		};
	};

	const end_style = async (
		companion: CompanionObject,
		data: { variant: StyleVariant },
		payload: any
	) => {
		const stringValue = getMarkdownFor(data.variant, 'end');

		return {
			companion: {
				mentions: [...companion.mentions],
			},
			stringValue,
		};
	};

	const table = async (
		companion: CompanionObject,
		data: { rows: unknown[][]; trailingNewline?: boolean },
		payload: any
	) => {
		const rows = Array.isArray(data.rows) ? data.rows : [];
		const stringValue = rows.map(row => stringifyTableRow(row)).join('\n')
			+ (data.trailingNewline ? '\n' : '');

		return {
			companion: {
				mentions: [...companion.mentions],
			},
			stringValue,
		};
	};

	const table_row = async (
		companion: CompanionObject,
		data: { cells: unknown[]; newline?: boolean },
		payload: any
	) => {
		const cells = Array.isArray(data.cells) ? data.cells : [];
		const stringValue = stringifyTableRow(cells) + (data.newline ?? true ? '\n' : '');

		return {
			companion: {
				mentions: [...companion.mentions],
			},
			stringValue,
		};
	};

	return {
		mention,
		invisiblemention,
		tageveryone,
		begin_style,
		end_style,
		// `kozz-boundary-maker` accepts arbitrary command names at runtime;
		// these extra helpers let us emit WhatsApp-renderable TSV tables.
		table,
		table_row,
	} as Partial<InlineCommandMap>;
};

export default baileysFunctions;
