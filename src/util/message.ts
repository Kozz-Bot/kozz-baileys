import { WAMessage } from 'baileys';

export const baileysMessageTypes = [
	'videoMessage',
	'stickerMessage',
	'imageMessage',
	'audioMessage',
	'extendedTextMessage',
];

const getMessageContent = (message: WAMessage) => {
	return (
		message.message?.ephemeralMessage?.message ||
		message.message?.viewOnceMessageV2?.message ||
		message.message?.viewOnceMessageV2Extension?.message ||
		message.message
	);
};

export const getQuotedMessageId = (message: WAMessage) => {
	const messageContent = getMessageContent(message);
	const contextInfo = (
		messageContent?.extendedTextMessage ||
		messageContent?.audioMessage ||
		messageContent?.stickerMessage ||
		messageContent?.videoMessage ||
		messageContent?.imageMessage
	)?.contextInfo;

	return contextInfo?.stanzaId;
};
