import { initSession } from './Client';
import baileysFunctions, {
	inlineCommandMapFunctions,
} from './Client/BaileysFunctions';
import createBoundary from 'kozz-boundary-maker';
import { createFolderOnInit } from './util/utility';
import { createResourceGatheres } from './Resource';
import { CronJob } from 'cron';
import fs from 'fs/promises';
import { getQuotedMessageId } from './util/message';

export const boundary = createBoundary({
	url: process.env.GATEWAY_URL || 'ws://localhost:4521',
	chatPlatform: 'Baileys',
	name: process.env.BOUNDARY_NAME || 'kozz-baileys',
	inlineCommandMap: inlineCommandMapFunctions(),
});

createFolderOnInit();

const deleteOldMedia = () => {
	fs.readdir('./medias').then(files => {
		files.forEach(file => {
			fs.stat(`./medias/${file}`).then(stats => {
				if (Date.now() - stats.birthtimeMs > 86400000) {
					fs.unlink(`./medias/${file}`);
				}
			});
		});
	});
};

initSession(boundary).then(waSocket => {
	const baileys = baileysFunctions(waSocket);

	CronJob.from({
		cronTime: '0 */10 * * * *',
		onTick: deleteOldMedia,
		start: true,
		timeZone: 'America/Sao_Paulo',
	});

	boundary.handleReplyWithText((payload, companion, body) => {
		baileys.sendText(payload.chatId, body, payload.quoteId, companion.mentions);
	});

	boundary.handleReplyWithSticker(async (payload, companion, caption) => {
		baileys.sendMedia(
			payload.chatId,
			payload.media!,
			{
				caption,
				mentionedList: companion.mentions,
				asSticker: true,
				contact: payload.contact,
				emojis: payload.media?.stickerTags,
			},
			payload.quoteId
		);
	});

	boundary.handleReplyWithMedia((payload, companion, caption) => {
		baileys.sendMedia(
			payload.chatId,
			payload.media!,
			{
				caption,
				mentionedList: companion.mentions,
			},
			payload.quoteId
		);
	});

	boundary.handleSendMessage((payload, companion, body) => {
		console.log({ payload, companion, body });

		baileys.sendText(payload.chatId, body, undefined, companion.mentions);
	});

	boundary.handleSendMessageWithMedia((payload, companion, body) => {
		baileys.sendMedia(
			payload.chatId,
			payload.media!,
			{ caption: body, mentionedList: companion.mentions },
			payload.quoteId
		);
	});

	boundary.handleReactMessage(async payload => {
		baileys.reactMessage(payload.messageId, payload.emote);
	});

	boundary.hanldeDeleteMessage(payload => {
		baileys.deleteMessage(payload.messageId);
	});

	waSocket.ev.on('messages.upsert', async (upsert: any) => {
		for (const msg of upsert.messages ?? []) {
			const body =
				msg.message?.conversation ||
				msg.message?.extendedTextMessage?.text ||
				msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
				'';

			if (body.trim() !== '/lottie') {
				continue;
			}

			const chatId = msg.key.remoteJid;
			const quotedMessageId = getQuotedMessageId(msg);
			if (!chatId) {
				continue;
			}

			if (!quotedMessageId) {
				await baileys.sendText(
					chatId,
					'Quote a sticker with /lottie so I can generate a rotating Lottie test.',
					msg.key.id
				);
				continue;
			}

			await baileys.sendQuotedStickerAsGeneratedLottie(
				chatId,
				quotedMessageId,
				msg.key.id
			);
		}
	});

	createResourceGatheres(boundary, baileys);
});
