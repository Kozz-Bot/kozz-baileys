import { ContactPayload } from 'kozz-types';
import Context from 'src/Context';
import { ContactModel } from './models';

const database = Context.get('database');

export const saveContact = async (contact: ContactPayload): Promise<string> => {
	const oldContact = await database.getById('contact', contact.id);

	if (oldContact && !contact.publicName) {
		await database.upsert('contact', {
			...oldContact,
			publicName: oldContact.publicName,
		});
	} else {
		await database.upsert('contact', {
			...contact,
		});
	}

	return contact.id;
};

export const getContact = async (id: string): Promise<ContactModel | null> => {
	const contact = (await database.getById('contact', id)) as ContactModel | null;
	if (!contact) {
		return null;
	}

	return contact;
};

/**
 * Updates (or sets) the LID field on an existing contact record identified by
 * its phone-number JID (pn). If the contact is not found yet the mapping is
 * silently ignored — it will be applied once the contact is persisted.
 */
export const saveLidMapping = async (pn: string, lid: string): Promise<void> => {
	try {
		const existing = (await database.getById('contact', pn)) as ContactModel | null;
		if (!existing) {
			// Contact not in DB yet — nothing to update.
			return;
		}

		await database.upsert('contact', {
			...existing,
			lid,
		});
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
		const results = database.getValues('contact', (c: ContactModel) => c.lid === lid);
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
		const dbContact = await getContactByLid(lid);
		if (dbContact) {
			return dbContact.id;
		}
		return null;
	} catch (e) {
		console.warn('[ContactStore] resolveJidFromLid error:', e);
		return null;
	}
};
