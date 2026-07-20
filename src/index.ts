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
import { getMessage } from './Store/MessageStore';

export const boundary = createBoundary({
	url: process.env.GATEWAY_URL || 'ws://localhost:4521',
	chatPlatform: 'Baileys',
	name: process.env.BOUNDARY_NAME || 'kozz-baileys',
	namespace: process.env.KOZZ_NAMESPACE || process.env.NAMESPACE || 'default',
	inlineCommandMap: inlineCommandMapFunctions(),
});

createFolderOnInit();

const unwrapMessageContainers = (message: any) => {
	const wrapperCandidates = [
		'ephemeralMessage',
		'viewOnceMessage',
		'viewOnceMessageV2',
		'viewOnceMessageV2Extension',
		'documentWithCaptionMessage',
		'associatedChildMessage',
		'groupStatusMessage',
		'groupStatusMentionMessage',
		'statusMentionMessage',
		'limitSharingMessage',
		'botTaskMessage',
	];

	const visited = new Set<any>();
	const layers: { path: string; keys: string[] }[] = [];

	const walk = (current: any, path: string): { message: any; path: string } => {
		if (!current || typeof current !== 'object' || visited.has(current)) {
			return { message: current, path };
		}

		visited.add(current);
		layers.push({
			path,
			keys: Object.keys(current),
		});

		for (const wrapperKey of wrapperCandidates) {
			const nestedMessage = current?.[wrapperKey]?.message;
			if (nestedMessage && typeof nestedMessage === 'object') {
				return walk(nestedMessage, `${path}.${wrapperKey}.message`);
			}
		}

		if (current?.deviceSentMessage?.message) {
			return walk(current.deviceSentMessage.message, `${path}.deviceSentMessage.message`);
		}

		return { message: current, path };
	};

	const result = walk(message, 'message');

	return {
		...result,
		layers,
	};
};

const describeRichResponse = (richResponseMessage: any) => {
	if (!richResponseMessage) {
		return null;
	}

	return {
		messageType: richResponseMessage.messageType ?? null,
		submessageCount: richResponseMessage.submessages?.length ?? 0,
		submessages:
			richResponseMessage.submessages?.map((submessage: any, index: number) => ({
				index,
				messageType: submessage.messageType ?? null,
				messageText: submessage.messageText ?? null,
				tableRows:
					submessage.tableMetadata?.rows?.map((row: any) => ({
						isHeading: row.isHeading ?? false,
						items: row.items ?? [],
					})) ?? null,
				codeLanguage: submessage.codeMetadata?.codeLanguage ?? null,
				codeBlocks:
					submessage.codeMetadata?.codeBlocks?.map((block: any) => ({
						highlightType: block.highlightType ?? null,
						codeContent: block.codeContent ?? null,
					})) ?? null,
				latexText: submessage.latexMetadata?.text ?? null,
				latexExpressions:
					submessage.latexMetadata?.expressions?.map((expression: any) => ({
						latexExpression: expression.latexExpression ?? null,
						url: expression.url ?? null,
						width: expression.width ?? null,
						height: expression.height ?? null,
					})) ?? null,
				contentItems: submessage.contentItemsMetadata?.itemsMetadata ?? null,
			})) ?? [],
		unifiedResponse:
			richResponseMessage.unifiedResponse?.data != null
				? {
						dataType: Array.isArray(richResponseMessage.unifiedResponse.data)
							? 'number[]'
							: typeof richResponseMessage.unifiedResponse.data,
						byteLength: Array.isArray(richResponseMessage.unifiedResponse.data)
							? richResponseMessage.unifiedResponse.data.length
							: richResponseMessage.unifiedResponse.data?.length ?? null,
						base64:
							typeof richResponseMessage.unifiedResponse.data === 'string'
								? richResponseMessage.unifiedResponse.data
								: Buffer.from(richResponseMessage.unifiedResponse.data).toString('base64'),
					}
				: null,
	};
};

const buildDebugPayloadAnalysis = (rawPayload: any) => {
	const rawMessage = rawPayload?.message;
	const { message: unwrappedMessage, path, layers } = unwrapMessageContainers(rawMessage);
	const richResponseMessage = unwrappedMessage?.richResponseMessage;
	const botMetadata = rawMessage?.messageContextInfo?.botMetadata;

	return {
		topLevelMessageKeys: rawMessage ? Object.keys(rawMessage) : [],
		unwrappedMessagePath: path,
		unwrappedMessageKeys: unwrappedMessage ? Object.keys(unwrappedMessage) : [],
		messageLayers: layers,
		botCapabilities: botMetadata?.capabilityMetadata?.capabilities ?? [],
		modelMetadata: botMetadata?.modelMetadata ?? null,
		hasRichResponseMessage: !!richResponseMessage,
		richResponseMessage: describeRichResponse(richResponseMessage),
		contextQuotedMessageKeys:
			rawPayload?.message?.extendedTextMessage?.contextInfo?.quotedMessage
				? Object.keys(rawPayload.message.extendedTextMessage.contextInfo.quotedMessage)
				: [],
	};
};

const getCommandQuotedPayload = (msg: any) => {
	const messageContent =
		msg.message?.ephemeralMessage?.message ||
		msg.message?.viewOnceMessageV2?.message ||
		msg.message?.viewOnceMessageV2Extension?.message ||
		msg.message;

	const contextInfo =
		messageContent?.extendedTextMessage?.contextInfo ||
		messageContent?.imageMessage?.contextInfo ||
		messageContent?.videoMessage?.contextInfo ||
		messageContent?.audioMessage?.contextInfo ||
		messageContent?.stickerMessage?.contextInfo;

	return contextInfo?.quotedMessage;
};

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

			const trimmedBody = body.trim();

			if (trimmedBody === '/debug') {
				const chatId = msg.key.remoteJid;
				const quotedMessageId = getQuotedMessageId(msg);
				if (!chatId) {
					continue;
				}

				if (!quotedMessageId) {
					await baileys.sendText(
						chatId,
						'Reply to a message with /debug so I can log its raw payload.',
						msg.key.id
					);
					continue;
				}

				const quotedMessage = await getMessage(quotedMessageId);

				if (!quotedMessage?.originalMessagePayload) {
					console.log(
						'[DEBUG QUOTED PAYLOAD] quoted message not found in storage',
						{
							commandMessageId: msg.key.id,
							quotedMessageId,
							chatId,
						}
					);
					await baileys.sendText(
						chatId,
						'I could not find the quoted message payload in storage. Check the server logs.',
						msg.key.id
					);
					continue;
				}

				console.log('[DEBUG QUOTED PAYLOAD]', {
					commandMessageId: msg.key.id,
					quotedMessageId,
					chatId,
				});
				const rawPayload = JSON.parse(quotedMessage.originalMessagePayload);
				console.log(JSON.stringify(rawPayload, null, 2));
				console.log(
					'[DEBUG QUOTED PAYLOAD ANALYSIS]',
					JSON.stringify(buildDebugPayloadAnalysis(rawPayload), null, 2)
				);

				const commandQuotedPayload = getCommandQuotedPayload(msg);
				console.log(
					'[DEBUG COMMAND QUOTED PAYLOAD]',
					JSON.stringify(commandQuotedPayload ?? null, null, 2)
				);
				console.log(
					'[DEBUG COMMAND QUOTED PAYLOAD ANALYSIS]',
					JSON.stringify(
						buildDebugPayloadAnalysis({
							message: commandQuotedPayload,
						}),
						null,
						2
					)
				);

				await baileys.sendText(
					chatId,
					'Logged the stored payload plus the live quoted payload from your reply context to the server console.',
					msg.key.id
				);
				continue;
			}

			if (trimmedBody !== '/lottie') {
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
