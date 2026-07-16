import { ContactPayload } from 'kozz-types';
import Context from 'src/Context';
import { ContactModel, LidMappingModel } from './models';

const database = Context.get('database');

const LID_DOMAIN = '@lid';
const PN_DOMAIN = '@s.whatsapp.net';

const normalizeJid = (jid: string, defaultDomain: string) => {
	if (jid.includes('@')) {
		return jid;
	}

	return `${jid}${defaultDomain}`;
};

const normalizeLid = (lid: string) => normalizeJid(lid, LID_DOMAIN);
const normalizePn = (pn: string) => normalizeJid(pn, PN_DOMAIN);

export const saveContact = async (contact: ContactPayload): Promise<string> => {
	const knownLid =
		contact.id.endsWith(PN_DOMAIN) ? await resolveLidFromJid(contact.id) : null;
	const contactToSave: ContactModel = knownLid
		? {
				...contact,
				lid: knownLid,
			}
		: contact;
	const oldContact = await database.getById('contact', contactToSave.id);

	if (oldContact && !contactToSave.publicName) {
		await database.upsert('contact', {
			...oldContact,
			publicName: oldContact.publicName,
			lid: contactToSave.lid ?? oldContact.lid,
		});
	} else {
		await database.upsert('contact', {
			...oldContact,
			...contactToSave,
			lid: contactToSave.lid ?? oldContact?.lid,
		});
	}

	return contactToSave.id;
};

export const getContact = async (id: string): Promise<ContactModel | null> => {
	const contact = (await database.getById('contact', id)) as ContactModel | null;
	if (!contact) {
		return null;
	}

	return contact;
};

/**
 * Stores a LID -> phone-number JID mapping independently from contacts.
 * If the PN contact already exists, also mirrors the LID onto that contact for
 * compatibility with older lookups.
 */
export const saveLidMapping = async (pn: string, lid: string): Promise<void> => {
	try {
		const normalizedPn = normalizePn(pn);
		const normalizedLid = normalizeLid(lid);

		if (!normalizedPn.endsWith(PN_DOMAIN) || !normalizedLid.endsWith(LID_DOMAIN)) {
			return;
		}

		await database.upsert('lidMapping', {
			id: normalizedLid,
			lid: normalizedLid,
			pn: normalizedPn,
			updatedAt: Date.now(),
		});

		const existing = (await database.getById(
			'contact',
			normalizedPn
		)) as ContactModel | null;
		if (existing) {
			await database.upsert('contact', {
				...existing,
				lid: normalizedLid,
			});
		}
	} catch (e) {
		console.warn('[ContactStore] saveLidMapping error:', e);
	}
};

/**
 * Looks up a contact by its LID (@lid JID).
 * Returns null if no contact with that LID is stored.
 */
export const getContactByLid = async (lid: string): Promise<ContactModel | null> => {
	try {
		const normalizedLid = normalizeLid(lid);
		const resolvedPn = await resolveJidFromLid(normalizedLid);
		if (resolvedPn) {
			const contact = await getContact(resolvedPn);
			if (contact) {
				return contact;
			}
		}

		const results = database.getValues(
			'contact',
			(c: ContactModel) => c.lid === normalizedLid || c.id === normalizedLid
		);
		if (!results || results.length === 0) {
			return null;
		}
		return results[0] as ContactModel;
	} catch (e) {
		console.warn('[ContactStore] getContactByLid error:', e);
		return null;
	}
};

/**
 * Resolves a LID JID (e.g. "12345@lid") to a phone-number JID
 * (e.g. "5511999999999@s.whatsapp.net").
 *
 * Mappings are populated passively via:
 *  - `chats.phoneNumberShare` Baileys event (primary real-time source)
 *  - `messaging-history.set` lidPnMappings during history sync
 *  - `lid-mapping.update` Baileys event
 *
 * @param lid  The full LID JID, e.g. "12345678901@lid"
 * @returns The phone-number JID string or null if not yet known
 */
export const resolveJidFromLid = async (lid: string): Promise<string | null> => {
	try {
		const normalizedLid = normalizeLid(lid);
		const mapping = (await database.getById(
			'lidMapping',
			normalizedLid
		)) as LidMappingModel | null;
		if (mapping) {
			return mapping.pn;
		}

		const results = database.getValues(
			'contact',
			(c: ContactModel) => c.lid === normalizedLid
		);
		const dbContact = results?.[0];
		if (dbContact?.id && dbContact.id !== normalizedLid) {
			return dbContact.id;
		}
		return null;
	} catch (e) {
		console.warn('[ContactStore] resolveJidFromLid error:', e);
		return null;
	}
};

export const resolveLidFromJid = async (pn: string): Promise<string | null> => {
	try {
		const normalizedPn = normalizePn(pn);
		const mappings = database.getValues(
			'lidMapping',
			(mapping: LidMappingModel) => mapping.pn === normalizedPn
		);

		if (mappings?.[0]) {
			return mappings[0].lid;
		}

		const contact = await getContact(normalizedPn);
		return contact?.lid ?? null;
	} catch (e) {
		console.warn('[ContactStore] resolveLidFromJid error:', e);
		return null;
	}
};

export const saveLidMappings = async (
	mappings: Array<{ pn?: string; jid?: string; lid?: string }>
) => {
	for (const mapping of mappings) {
		const pn = mapping.pn ?? mapping.jid;
		const lid = mapping.lid;

		if (pn && lid) {
			await saveLidMapping(pn, lid);
		}
	}
};
