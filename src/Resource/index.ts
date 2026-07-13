import initBoundary from 'kozz-boundary-maker';
import baileysFunctions from 'src/Client/BaileysFunctions';
import Context from 'src/Context';
import {
	getAllGroupChats,
	getAllPrivateChats,
	getChatDetails,
	getGroupChat,
	getUnreadCount,
} from 'src/Store/ChatStore';
import { getContact } from 'src/Store/ContactStore';
import {
	getMessageCountByContact,
	getRecentChatMessages,
} from 'src/Store/MessageStore';
import { getChatOrder } from 'src/Store/MetadataStore';

export const createResourceGatheres = (
	boundary: ReturnType<typeof initBoundary>,
	baileys: ReturnType<typeof baileysFunctions>
) => {
	const _getProfilePicUrl = async ({ id }: { id: string }) => {
		if (!id) {
			return console.warn('Tried to fetch profile pic but no ID was provided!');
		}

		const picUrl = await baileys.getProfilePic(id);
		return picUrl;
	};

	const _getGroupChatInfo = async ({ id }: { id: string }) => {
		if (!id) {
			return console.warn('Tried to fetch group chat info but no ID was provided');
		}
		if (!id.includes('@g.us')) {
			return console.warn(
				'Tried to fetch group chat info but got an invalid ID:',
				id
			);
		}
		const groupData = await getGroupChat(id);
		if (!groupData) {
			return console.warn('Unable to fetch group chat info for ID:', id);
		}

		return groupData;
	};

	const _groupAdminList = async ({ id }: { id: string }) => {
		if (!id) {
			return console.warn('Tried to fetch group chat info but no ID was provided');
		}
		if (!id.includes('@g.us')) {
			return console.warn(
				'Tried to fetch group chat info but got an invalid ID:',
				id
			);
		}
		const groupData = await getGroupChat(id);
		if (!groupData) {
			return console.warn('Unable to fetch admin list from group ID:', id);
		}

		return {
			adminList: groupData.participants?.filter(member => member.admin),
		};
	};

	const _getUnreadCount = async ({ id }: { id: string }) => {
		const unreadCount = await getUnreadCount(id);
		return unreadCount;
	};

	const _getChatDetails = async ({ id }: { id: string }) => {
		const chatDetails = getChatDetails(id);
		return chatDetails;
	};

	const _getContactInfo = async ({ id }: { id: string }) => {
		if (!id) {
			return console.warn('Tried to fetch contact info but no ID was provided');
		}
		if (id.includes('@g.us')) {
			return console.warn('Tried to fetch contact info but got an invalid ID:', id);
		}

		const contactInfo = await getContact(id);
		return contactInfo;
	};

	const _chatStatus = () => {
		return {
			qr: Context.get('qr'),
			ready: Context.get('ready'),
		};
	};

	const _getAllGroups = () => {
		const allGroups = getAllGroupChats();
		return allGroups;
	};

	const _getAllPrivateChats = () => {
		return getAllPrivateChats();
	};

	const _getRecentChatMessages = async ({
		chatId,
		limit,
		excludeMessageId,
	}: {
		chatId?: string;
		limit?: number;
		excludeMessageId?: string;
	}) => {
		if (!chatId) {
			return console.warn('Tried to fetch recent messages but no chatId was provided');
		}

		return getRecentChatMessages({ chatId, limit, excludeMessageId });
	};

	const _getMessageCount = ({
		chatId,
		startTimestamp,
	}: {
		chatId?: string;
		startTimestamp?: number;
	}) => {
		if (!chatId) {
			return console.warn('Tried to fetch message count but no chatId was provided');
		}

		return getMessageCountByContact({ chatId, startTimestamp });
	};

	boundary.onAskResource('contact_profile_pic', _getProfilePicUrl);
	boundary.onAskResource('group_chat_info', _getGroupChatInfo);
	boundary.onAskResource('group_admin_list', _groupAdminList);
	boundary.onAskResource('unread_count', _getUnreadCount);
	boundary.onAskResource('chat_details', _getChatDetails);
	boundary.onAskResource('contact_info', _getContactInfo);
	boundary.onAskResource('chat_order', getChatOrder);
	boundary.onAskResource('chat_status', _chatStatus);
	boundary.onAskResource('all_groups', _getAllGroups);
	boundary.onAskResource('all_private_chats', _getAllPrivateChats);
	boundary.onAskResource('recent_chat_messages', _getRecentChatMessages);
	boundary.onAskResource('message_count', _getMessageCount);
};
