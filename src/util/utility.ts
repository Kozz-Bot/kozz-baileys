import fs from 'fs';
import { ContactPayload, MessageReceived } from 'kozz-types';

export const createFolderOnInit = () => {
	tryCreateFolder(`./medias`);
	tryCreateFolder(`./debug`);
	tryCreateFolder(`./debug/lottie`);
	tryCreateFolder(`./debug/lottie/generated`);
};

const tryCreateFolder = (path: string) => {
	try {
		fs.mkdirSync(path);
	} catch {}
};

export const clearContact = (Contact: string) => {
	/**
	 *  '554899295890:3@s.whatsapp.net' to
	 *  '554899295890@s.whatsapp.net'
	 */
	return Contact.replace(/\:[0-9]*\@/, '@');
};

export const getVisibleContactMention = (contactId: string) => {
	return '@' + clearContact(contactId).split('@')[0];
};

export const getMyContactFromCredentials = (creds?: {
	me?: {
		id?: string;
		lid?: string;
		name?: string;
	};
}) => {
	let jsonCred:
		| {
					me?: {
						id?: string;
						lid?: string;
						name?: string;
					};
		  }
		| undefined = creds;

	if (!jsonCred) {
		const credFile = fs.readFileSync('./creds/creds.json');
		jsonCred = JSON.parse(credFile.toString());
	}

	if (!jsonCred?.me?.id) {
		throw new Error('Credentials do not have a WhatsApp contact');
	}

	return {
		...jsonCred.me,
		id: clearContact(jsonCred.me.id),
		lid: jsonCred.me.lid ? clearContact(jsonCred.me.lid) : undefined,
	};
};

export const replaceTaggedName = (text: string, tagged: ContactPayload[]) => {
	const contacts = tagged.map(contact => {
		const sanitizedId = getVisibleContactMention(contact.id);
		const publicName = contact.publicName;

		return {
			sanitizedId,
			publicName,
		};
	});

	return text
		.split(' ')
		.map(word => {
			if (!word.startsWith('@')) {
				return word;
			}

			const contact = contacts.find(contact => contact.sanitizedId === word);
			if (contact) {
				return contact.publicName;
			}

			return word;
		})
		.join(' ');
};

export const generateHash = async (length: number) => {
	var result = '';
	var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	var charactersLength = characters.length;
	for (var i = 0; i < length; i++) {
		result += characters.charAt(Math.floor(Math.random() * charactersLength));
	}
	return result;
};

export const getFormattedDateAndTime = (date?: number | Date) => {
	const timestamp =
		typeof date === 'number' && date > 0
			? date < 1e12
				? date * 1000
				: date
			: date;
	const now = timestamp ? new Date(timestamp) : new Date();
	const parts = new Intl.DateTimeFormat('pt-BR', {
		timeZone: 'America/Sao_Paulo',
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).formatToParts(now);
	const getPart = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find(part => part.type === type)?.value ?? '';

	return `${getPart('day')}/${getPart('month')}/${getPart('year')} às ${getPart(
		'hour'
	)}:${getPart('minute')}`;
};

export const removeUndefinedEntries = <Obj extends Record<string, any>>(
	obj: Obj
): Obj => {
	const objCopy = structuredClone(obj);
	for (const key in objCopy) {
		if (objCopy[key] === undefined) {
			delete objCopy[key];
		}
	}
	return objCopy;
};

export const getMessagePreview = (message: MessageReceived) => {
	const type = message.messageType;

	if (type === 'TEXT') {
		return message.body;
	}

	return toPascalCase(type);
};

export const toPascalCase = (str: string): string => {
	return str
		.split(/[\s_-]+/)
		.map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join('');
};
