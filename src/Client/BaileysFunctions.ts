import { WaSocket } from '.';
import {
	AnyMessageContent,
	generateWAMessageFromContent,
	prepareWAMessageMedia,
	proto,
} from 'baileys';
import JSZip from 'jszip';
import { ContactPayload, Media } from 'kozz-types';
import context from '../Context';
import { downloadBuffer } from 'src/util/downloadBuffer';
import { convertJpegToWebp, convertMP4ToWebp } from 'src/MediaConverter';
import { getMessage } from 'src/Store/MessageStore';
import { getContactByLid } from 'src/Store/ContactStore';
import { generateHash, getFormattedDateAndTime } from 'src/util/utility';
import fs from 'fs';
import {
	CompanionObject,
	InlineCommandMap,
	StyleVariant,
} from 'kozz-boundary-maker/dist/InlineCommand';
import { getGroupChat } from 'src/Store/ChatStore';
import logger from 'src/util/logger';
import sharp from 'sharp';
const webp = require('node-webpmux'); // import has type error.

const database = context.get('database');

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

const baileysFunctions = (client: WaSocket) => {
	const checkNumber = async (id: string) => {
		const result = await client.onWhatsApp(`${id}`);
		return result?.[0].exists;
	};

	const sendText = async (
		receiverId: string,
		text: string,
		quotedMessageId?: string,
		tagged?: string[]
	) => {
		return client.sendMessage(
			receiverId,
			{
				text,
				mentions: tagged,
			},
			{
				quoted: getOGQuotedMessagePayload(quotedMessageId),
			}
		);
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
				return client.sendMessage(
					contactId,
					{
						...sendMediaOptions,
						sticker: mediaData,
						isAnimated: isAnimated,
					},
					{
						quoted: getOGQuotedMessagePayload(quoteId),
					}
				);
			} catch (e) {
				return undefined;
			}
		}

		if (media.mimeType.startsWith('audio')) {
			try {
				return client.sendMessage(
					contactId,
					{
						...sendMediaOptions,
						audio: mediaData,
						ptt: options?.asVoiceNote,
						mimetype: 'audio/mp4',
					},
					{
						quoted: getOGQuotedMessagePayload(quoteId),
					}
				);
			} catch (e) {
				return undefined;
			}
		}

		if (media.mimeType.startsWith('image')) {
			try {
				return await client.sendMessage(
					contactId,
					{
						...sendMediaOptions,
						image: mediaData,
					},
					{
						quoted: getOGQuotedMessagePayload(quoteId),
					}
				);
			} catch (e) {
				return undefined;
			}
		}

		if (media.mimeType.startsWith('video')) {
			try {
				return client.sendMessage(
					contactId,
					{
						...sendMediaOptions,
						video: mediaData,
					},
					{
						quoted: getOGQuotedMessagePayload(quoteId),
					}
				);
			} catch (e) {
				return undefined;
			}
		}
		try {
			return client.sendMessage(
				contactId,
				{
					...sendMediaOptions,
					text: '',
					document: mediaData,
				},
				{
					quoted: getOGQuotedMessagePayload(quoteId),
				}
			);
		} catch (e) {
			return undefined;
		}
	};

	const reactMessage = async (messageId: string, emoji: string) => {
		const ogMessage = await getMessage(messageId);
		if (!ogMessage) {
			return;
		}

		const ogPayload = JSON.parse(
			ogMessage.originalMessagePayload
		) as proto.IWebMessageInfo;

		return client.sendMessage(ogPayload.key.remoteJid!, {
			react: {
				key: ogPayload.key,
				text: emoji,
			},
		});
	};

	const getProfilePic = async (contactId: string) => {
		try {
			const profilePic = await client.profilePictureUrl(contactId, 'image');
			return profilePic;
		} catch (e) {
			console.warn(e);
			return undefined;
		}
	};

	const deleteMessage = async (messageId: string) => {
		try {
			const ogMessage = await getMessage(messageId);
			if (!ogMessage) {
				return;
			}

			const ogPayload = JSON.parse(
				ogMessage.originalMessagePayload
			) as proto.IWebMessageInfo;

			const response = await client.sendMessage(ogPayload.key.remoteJid!, {
				delete: ogPayload.key,
			});
			return response;
		} catch (e) {
			console.warn(e);
			return undefined;
		}
	};

	/**
	 * Looks up a contact by its LID (@lid JID).
	 * Returns the full ContactModel (including phone-number `id`) or null.
	 */
	const getContactFromLid = async (lid: string) => {
		return getContactByLid(lid);
	};

	const getKnownLottiePath = () => {
		const lottieDir = './debug/lottie';
		if (!fs.existsSync(lottieDir)) {
			return undefined;
		}

		const candidates = fs
			.readdirSync(lottieDir)
			.filter(fileName => fileName.endsWith('.was'))
			.map(fileName => ({
				fileName,
				fullPath: `${lottieDir}/${fileName}`,
				mtimeMs: fs.statSync(`${lottieDir}/${fileName}`).mtimeMs,
			}))
			.sort((a, b) => b.mtimeMs - a.mtimeMs);

		return candidates[0]?.fullPath;
	};

	const buildRotatingSecondaryLottieAnimation = (
		pngBuffer: Buffer,
		outputKey: string
	) => {
		const canvasSize = 512;
		const centerX = canvasSize / 2;
		const centerY = canvasSize / 2;
		const inlineAsset = `data:image/png;base64,${pngBuffer.toString('base64')}`;

		return {
			nm: 'Main Scene',
			ddd: 0,
			h: canvasSize,
			w: canvasSize,
			meta: {
				g: '@lottiefiles/creator 1.87.1',
			},
			layers: [
				{
					ty: 2,
					nm: `quoted_${outputKey}`,
					sr: 1,
					st: 0,
					op: 150,
					ip: 0,
					hd: false,
					ddd: 0,
					bm: 0,
					hasMask: false,
					ao: 0,
					ks: {
						a: {
							a: 0,
							k: [centerX, centerY],
						},
						s: {
							a: 0,
							k: [100, 100],
						},
						sk: {
							a: 0,
							k: 0,
						},
						p: {
							a: 0,
							k: [centerX, centerY],
						},
						r: {
							a: 1,
							k: [
								{
									o: { x: 0.7, y: 0.064 },
									i: { x: 0.3, y: 0.936 },
									s: [0],
									t: 0,
								},
								{
									s: [360],
									t: 150,
								},
							],
						},
						sa: {
							a: 0,
							k: 0,
						},
						o: {
							a: 0,
							k: 100,
						},
					},
					refId: 'quoted_sticker',
					ind: 1,
				},
			],
			v: '5.7.0',
			fr: 30,
			ip: 0,
			op: 150,
			assets: [
				{
					id: 'quoted_sticker',
					w: canvasSize,
					h: canvasSize,
					p: inlineAsset,
					e: 1,
				},
			],
		};
	};

	const getQuotedStickerPng = async (quotedSticker: Media) => {
		const quotedStickerBuffer =
			quotedSticker.transportType === 'b64'
				? Buffer.from(quotedSticker.data, 'base64')
				: await downloadBuffer(quotedSticker.data);

		return sharp(quotedStickerBuffer)
			.resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.png()
			.toBuffer();
	};

	const createGeneratedLottieWas = async (quotedSticker: Media, outputKey: string) => {
		const validLottiePath = getKnownLottiePath();
		if (!validLottiePath) {
			throw new Error('No valid .was file available in ./debug/lottie');
		}

		const quotedStickerPng = await getQuotedStickerPng(quotedSticker);

		const zip = await JSZip.loadAsync(fs.readFileSync(validLottiePath));
		const animation = await buildRotatingSecondaryLottieAnimation(
			quotedStickerPng,
			outputKey
		);

		zip.file('animation/animation_secondary.json', JSON.stringify(animation));

		const generatedBuffer = await zip.generateAsync({
			type: 'nodebuffer',
			compression: 'DEFLATE',
		});

		const outputPath = `./debug/lottie/generated/${outputKey}.was`;
		fs.writeFileSync(outputPath, generatedBuffer);
		return outputPath;
	};

	const getQuotedStickerForLottie = async (
		receiverId: string,
		quotedSourceMessageId: string,
		replyToMessageId?: string
	): Promise<Media | undefined> => {
		const quotedMessage = await getMessage(quotedSourceMessageId);
		if (!quotedMessage) {
			await sendText(receiverId, 'Quoted message not found in storage.', replyToMessageId);
			return undefined;
		}

		if (quotedMessage.messageType !== 'STICKER' || !quotedMessage.media) {
			await sendText(
				receiverId,
				'Quote a sticker message so I can turn it into a rotating Lottie test.',
				replyToMessageId
			);
			return undefined;
		}

		if (quotedMessage.media.mimeType === 'application/was') {
			await sendText(
				receiverId,
				'Quoted Lottie stickers are not supported as a basis yet. Quote a regular sticker first.',
				replyToMessageId
			);
			return undefined;
		}

		return quotedMessage.media;
	};

	const sendLottieBundle = async (
		receiverId: string,
		lottiePath: string,
		replyToMessageId?: string
	) => {
		const lottieBuffer = fs.readFileSync(lottiePath);
		const preparedMedia = await prepareWAMessageMedia(
			{
				sticker: lottieBuffer,
				mimetype: 'application/was',
				isAnimated: true,
			},
			{
				upload: client.waUploadToServer,
				jid: receiverId,
				logger,
				mediaTypeOverride: 'sticker',
			}
		);

		const stickerMessage = preparedMedia.stickerMessage;
		if (!stickerMessage) {
			throw new Error('prepareWAMessageMedia returned no stickerMessage');
		}

		stickerMessage.mimetype = 'application/was';
		stickerMessage.isAnimated = true;
		stickerMessage.isLottie = true;

		const fullMessage = generateWAMessageFromContent(
			receiverId,
			{
				lottieStickerMessage: {
					message: {
						stickerMessage,
					},
				},
			},
			{
				userJid: client.user?.id || context.get('hostData').id,
				quoted: getOGQuotedMessagePayload(replyToMessageId),
			}
		);

		await client.relayMessage(receiverId, fullMessage.message!, {
			messageId: fullMessage.key.id!,
		});

		return fullMessage;
	};

	const sendDebugLottie = async (receiverId: string, quotedMessageId?: string) => {
		const lottiePath = getKnownLottiePath();
		if (!lottiePath) {
			console.warn('LOTTIE SEND DEBUG: no .was file available in ./debug/lottie');
			return undefined;
		}

		try {
			console.log(`LOTTIE SEND DEBUG: sending ${lottiePath} to ${receiverId}`);
			return await sendLottieBundle(receiverId, lottiePath, quotedMessageId);
		} catch (error) {
			console.warn('LOTTIE SEND DEBUG: failed to send lottie sticker');
			console.warn(error);
			return undefined;
		}
	};

	const sendQuotedStickerAsGeneratedLottie = async (
		receiverId: string,
		quotedSourceMessageId: string,
		replyToMessageId?: string
	) => {
		const quotedSticker = await getQuotedStickerForLottie(
			receiverId,
			quotedSourceMessageId,
			replyToMessageId
		);
		if (!quotedSticker) {
			return undefined;
		}

		try {
			const outputKey = `${quotedSourceMessageId}_${Date.now()}`;
			const generatedLottiePath = await createGeneratedLottieWas(quotedSticker, outputKey);

			console.log(
				`LOTTIE SEND DEBUG: generated hybrid test ${generatedLottiePath} from quoted sticker ${quotedSourceMessageId}`
			);
			return await sendLottieBundle(
				receiverId,
				generatedLottiePath,
				replyToMessageId
			);
		} catch (error) {
			console.warn('LOTTIE SEND DEBUG: failed to build/send generated lottie sticker');
			console.warn(error);
			await sendText(
				receiverId,
				'Failed to build the generated Lottie sticker. Check the logs.',
				replyToMessageId
			);
			return undefined;
		}
	};

	return {
		checkNumber,
		sendMedia,
		sendText,
		reactMessage,
		getProfilePic,
		deleteMessage,
		getContactFromLid,
		sendDebugLottie,
		sendQuotedStickerAsGeneratedLottie,
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
			stringValue: '@' + data.id.replace('@s.whatsapp.net', ''),
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

	return {
		mention,
		invisiblemention,
		tageveryone,
		begin_style,
		end_style,
	};
};

export default baileysFunctions;
