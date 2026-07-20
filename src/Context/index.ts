import { initDatabase } from 'src/Store/DataManager';
import { getMyContactFromCredentials } from 'src/util/utility';

type ContextData = {
	blockedList: string[];
	ready: boolean;
	qr: string | null;
	hostData: {
		id: string;
		lid?: string;
		pushName: string;
	};
	database: ReturnType<typeof initDatabase>;
};

export const setMeFromCreds = (creds?: Parameters<typeof getMyContactFromCredentials>[0]) => {
	let me = {
		id: '',
		lid: undefined as string | undefined,
		pushName: '',
	};
	try {
		const meCred = getMyContactFromCredentials(creds);
		me.id = meCred.id;
		me.lid = meCred.lid;
		me.pushName = meCred.name || '';
	} catch (e) {}
	return me;
};

const AppContext = () => {
	// Initial context
	const me = setMeFromCreds();

	let contextData: ContextData = {
		blockedList: [],
		ready: false,
		qr: null,
		hostData: me,
		database: initDatabase(),
	};

	const upsert = (data: Partial<ContextData>) => {
		contextData = {
			...contextData,
			...data,
		};
	};

	const get = <Key extends keyof ContextData>(key: Key): ContextData[Key] => {
		return contextData[key];
	};

	return {
		get,
		upsert,
	};
};

export default AppContext();
