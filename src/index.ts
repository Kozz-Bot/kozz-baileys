import { getActiveSocket, initSession } from './Client';
import baileysFunctions, {
	inlineCommandMapFunctions,
} from './Client/BaileysFunctions';
import createBoundary from 'kozz-boundary-maker';
import { createFolderOnInit } from './util/utility';
import { createResourceGatheres } from './Resource';
import { CronJob } from 'cron';
import fs from 'fs/promises';
import path from 'path';
import { getQuotedMessageId } from './util/message';
import { getMessage } from './Store/MessageStore';
import { appPaths, boundaryName, describeInstance, namespace } from './InstanceConfig';
import { classifyBaileysMessage, getMessageContent } from './PayloadTransformers';

export const boundary = createBoundary({
	url: process.env.GATEWAY_URL || 'ws://localhost:4521',
	chatPlatform: 'Baileys',
	name: boundaryName,
	namespace,
	inlineCommandMap: inlineCommandMapFunctions(),
});

createFolderOnInit();
const instanceDescription = describeInstance();
console.log(
	`Starting kozz-baileys instance boundaryName=${instanceDescription.boundaryName} namespace=${instanceDescription.namespace} instanceId=${instanceDescription.instanceId} instanceRoot=${instanceDescription.instanceRoot}`
);

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

const summarizeDebugPayloadAnalysis = (
	analysis: ReturnType<typeof buildDebugPayloadAnalysis>
) =>
	[
		`topLevelKeys=${analysis.topLevelMessageKeys.join(',') || 'none'}`,
		`unwrappedPath=${analysis.unwrappedMessagePath}`,
		`unwrappedKeys=${analysis.unwrappedMessageKeys.join(',') || 'none'}`,
		`layers=${analysis.messageLayers.length}`,
		`botCapabilities=${analysis.botCapabilities?.length ?? 0}`,
		`hasRichResponse=${analysis.hasRichResponseMessage}`,
		`contextQuotedKeys=${analysis.contextQuotedMessageKeys.join(',') || 'none'}`,
	].join(' ');

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
	fs.readdir(appPaths.mediaDir).then(files => {
		files.forEach(file => {
			const filePath = path.join(appPaths.mediaDir, file);
			fs.stat(filePath).then(stats => {
				if (Date.now() - stats.birthtimeMs > 86400000) {
					fs.unlink(filePath);
				}
			});
		});
	});
};

const safelySend = async (label: string, send: () => Promise<unknown>) => {
	try {
		return await send();
	} catch (error) {
		console.error(
			`[send] ${label} failed:`,
			error instanceof Error ? error.message : error
		);
		console.error(error);
	}
};

initSession(boundary).then(waSocket => {
	const baileys = baileysFunctions(() => getActiveSocket() || waSocket);
	const getBaileys = () => baileys;

	CronJob.from({
		cronTime: '0 */10 * * * *',
		onTick: deleteOldMedia,
		start: true,
		timeZone: 'America/Sao_Paulo',
	});

	boundary.handleReplyWithText((payload, companion, body) => {
		if (!payload?.chatId || !payload?.quoteId) {
			console.warn('[reply_with_text] Invalid payload', payload);
			return;
		}

		return safelySend('reply_with_text', () =>
			getBaileys().sendText(payload.chatId, body, payload.quoteId, companion.mentions)
		);
	});

	boundary.kozzSocket.on(
		'iwac_reply_text',
		(payload: { chatId?: string; body?: string; quoteId?: string }) => {
			if (!payload?.chatId || !payload?.body || !payload?.quoteId) {
				console.warn('[iwac_reply_text] Invalid payload', payload);
				return;
			}

			return safelySend('iwac_reply_text', () =>
				getBaileys().sendText(payload.chatId!, payload.body!, payload.quoteId!)
			);
		}
	);

	boundary.handleReplyWithSticker(async (payload, companion, caption) => {
		return safelySend('reply_with_sticker', () =>
			getBaileys().sendMedia(
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
			)
		);
	});

	boundary.handleReplyWithMedia((payload, companion, caption) => {
		return safelySend('reply_with_media', () =>
			getBaileys().sendMedia(
				payload.chatId,
				payload.media!,
				{
					caption,
					mentionedList: companion.mentions,
				},
				payload.quoteId
			)
		);
	});

	boundary.handleSendMessage((payload, companion, body) => {
		return safelySend('send_message', () =>
			getBaileys().sendText(payload.chatId, body, undefined, companion.mentions)
		);
	});

	boundary.handleSendMessageWithMedia((payload, companion, body) => {
		return safelySend('send_message_with_media', () =>
			getBaileys().sendMedia(
				payload.chatId,
				payload.media!,
				{ caption: body, mentionedList: companion.mentions },
				payload.quoteId
			)
		);
	});

	boundary.handleReactMessage(async payload => {
		return safelySend('react_message', () =>
			getBaileys().reactMessage(payload.messageId, payload.emote)
		);
	});

	boundary.hanldeDeleteMessage(payload => {
		return safelySend('delete_message', () =>
			getBaileys().deleteMessage(payload.messageId)
		);
	});

	waSocket.ev.on('messages.upsert', async (upsert: any) => {
		if (upsert.type && upsert.type !== 'notify') {
			return;
		}

		for (const msg of upsert.messages ?? []) {
			if (classifyBaileysMessage(msg).kind !== 'user_message') {
				continue;
			}

			const messageContent = getMessageContent(msg);
			const body =
				messageContent?.conversation || messageContent?.extendedTextMessage?.text || '';

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
						`[DEBUG QUOTED PAYLOAD] quoted message not found commandMessageId=${msg.key.id ?? 'unknown'} quotedMessageId=${quotedMessageId} chatId=${chatId}`
					);
					await baileys.sendText(
						chatId,
						'I could not find the quoted message payload in storage. Check the server logs.',
						msg.key.id
					);
					continue;
				}

				const rawPayload = JSON.parse(quotedMessage.originalMessagePayload);
				console.log(
					`[DEBUG QUOTED PAYLOAD] commandMessageId=${msg.key.id ?? 'unknown'} quotedMessageId=${quotedMessageId} chatId=${chatId} ${summarizeDebugPayloadAnalysis(buildDebugPayloadAnalysis(rawPayload))}`
				);

				const commandQuotedPayload = getCommandQuotedPayload(msg);
				console.log(
					`[DEBUG COMMAND QUOTED PAYLOAD] ${summarizeDebugPayloadAnalysis(buildDebugPayloadAnalysis({
						message: commandQuotedPayload,
					}))}`
				);

				await baileys.sendText(
					chatId,
					'Logged the stored payload plus the live quoted payload from your reply context to the server console.',
					msg.key.id
				);
				continue;
			}
		}
	});

	createResourceGatheres(boundary, baileys);
});
