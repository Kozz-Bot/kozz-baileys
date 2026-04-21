import fs from 'fs';
import zlib from 'zlib';
import { downloadContentFromMessage, downloadMediaMessage, WAMessage } from 'baileys';
import { Media } from 'kozz-types';
import { WaSocket } from 'src/Client';
import logger from './logger';

const messageMediaTypes = [
	'videoMessage',
	'stickerMessage',
	'imageMessage',
	'audioMessage',
] as const;

const getMessageContent = (message: WAMessage) => {
	return (
		message.message?.ephemeralMessage?.message ||
		message.message?.viewOnceMessageV2?.message ||
		message.message?.viewOnceMessageV2Extension?.message ||
		message.message?.lottieStickerMessage?.message ||
		message.message
	);
};

const logLottieDetection = (
	messageEv: WAMessage,
	messageContent: NonNullable<WAMessage['message']>
) => {
	const hasLottieWrapper = !!messageEv.message?.lottieStickerMessage;
	const stickerMessage = messageContent.stickerMessage;
	const isLottieSticker = !!stickerMessage?.isLottie;

	if (!hasLottieWrapper && !isLottieSticker) {
		return;
	}

	console.log('LOTTIE STICKER DETECTED');
	console.log(
		JSON.stringify(
			{
				messageId: messageEv.key.id,
				remoteJid: messageEv.key.remoteJid,
				hasLottieWrapper,
				isLottieSticker,
				mimetype: stickerMessage?.mimetype,
				directPath: stickerMessage?.directPath,
				fileLength: stickerMessage?.fileLength?.toString(),
			},
			null,
			2
		)
	);
};

const bufferStartsWith = (buffer: Buffer, signature: number[]) => {
	return signature.every((byte, index) => buffer[index] === byte);
};

const getLottieDebugInfo = (mediaBuffer: Buffer) => {
	const firstBytesHex = mediaBuffer.subarray(0, 64).toString('hex');
	const asText = mediaBuffer.subarray(0, 256).toString('utf8');
	const looksLikeJson =
		asText.trimStart().startsWith('{') || asText.trimStart().startsWith('[');
	const isGzip = bufferStartsWith(mediaBuffer, [0x1f, 0x8b]);
	const isZip = bufferStartsWith(mediaBuffer, [0x50, 0x4b, 0x03, 0x04]);
	const isWebp = bufferStartsWith(mediaBuffer, [0x52, 0x49, 0x46, 0x46]);
	const isMp4 =
		mediaBuffer.length > 8 && mediaBuffer.subarray(4, 8).toString('ascii') === 'ftyp';

	return {
		firstBytesHex,
		looksLikeJson,
		isGzip,
		isZip,
		isWebp,
		isMp4,
	};
};

const dumpLottieStickerDebug = (messageEv: WAMessage, mediaBuffer: Buffer) => {
	const messageId = messageEv.key.id || `unknown_${Date.now()}`;
	const basePath = `./debug/lottie/${messageId}`;
	const info = getLottieDebugInfo(mediaBuffer);
	const rawPath = `${basePath}.was`;

	fs.writeFileSync(rawPath, mediaBuffer);

	const debugSummary = {
		messageId,
		sizeInBytes: mediaBuffer.length,
		rawPath,
		...info,
	};

	if (info.isGzip) {
		try {
			const gunzipped = zlib.gunzipSync(mediaBuffer);
			const unpackedPath = `${basePath}.gunzipped`;
			fs.writeFileSync(unpackedPath, gunzipped);
			Object.assign(debugSummary, {
				gunzippedPath: unpackedPath,
				gunzippedLooksLikeJson: gunzipped
					.subarray(0, 256)
					.toString('utf8')
					.trimStart()
					.startsWith('{'),
			});
		} catch (error) {
			Object.assign(debugSummary, {
				gzipError: error instanceof Error ? error.message : String(error),
			});
		}
	}

	console.log('LOTTIE STICKER DEBUG');
	console.log(JSON.stringify(debugSummary, null, 2));
};

const streamToBuffer = async (stream: AsyncIterable<Buffer>) => {
	const chunks: Buffer[] = [];

	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	return Buffer.concat(chunks);
};

export const downloadMediaFromMessage = async (
	messageEv: WAMessage,
	waSocket: WaSocket
): Promise<Media | undefined> => {
	const messageContent = getMessageContent(messageEv);
	if (!messageContent) {
		return undefined;
	}

	logLottieDetection(messageEv, messageContent);

	const stickerMessage = messageContent.stickerMessage;

	if (stickerMessage?.isAnimated && !stickerMessage?.isLottie) {
		stickerMessage.mimetype = 'video/mp4';
	}

	const mediaType = messageMediaTypes.find(
		messageType => !!messageContent[messageType]
	);

	if (!mediaType) {
		if (messageEv.message?.lottieStickerMessage || stickerMessage?.isLottie) {
			console.log(
				`LOTTIE STICKER SKIPPED ${messageEv.key.id}: no supported media type found after unwrap`
			);
		}
		return undefined;
	}

	try {
		if (stickerMessage?.isLottie) {
			console.log(
				`LOTTIE STICKER DOWNLOAD START ${messageEv.key.id} (${messageContent[mediaType]?.mimetype})`
			);
		}

		const mediaBuffer = stickerMessage?.isLottie
			? await streamToBuffer(
					await downloadContentFromMessage(
						{
							directPath: stickerMessage.directPath!,
							mediaKey: stickerMessage.mediaKey!,
							url: stickerMessage.url || undefined,
						},
						'sticker',
						{}
					)
				)
			: await downloadMediaMessage(
					messageEv,
					'buffer',
					{},
					{
						logger,
						reuploadRequest: waSocket.updateMediaMessage,
					}
				);

		if (stickerMessage?.isLottie) {
			dumpLottieStickerDebug(messageEv, mediaBuffer);
		}

		return {
			data: mediaBuffer.toString('base64'),
			fileName: messageContent[mediaType]?.directPath || null,
			mimeType: messageContent[mediaType]!.mimetype!,
			sizeInBytes: Number(messageContent[mediaType]!.fileLength!) || null,
			transportType: 'b64',
			stickerTags: undefined,
			duration: null,
		};
	} catch (e) {
		if (stickerMessage?.isLottie) {
			console.warn(`LOTTIE STICKER DOWNLOAD FAILED ${messageEv.key.id}`);
		}
		console.warn(e);
		return undefined;
	}
};
