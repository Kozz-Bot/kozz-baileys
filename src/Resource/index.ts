import initBoundary from 'kozz-boundary-maker';
import baileysFunctions from 'src/Client/BaileysFunctions';
import Context from 'src/Context';
import {
	getAllGroupChats,
	getAllPrivateChats,
	getChatDetails,
	getGroupChat,
	getUnreadCount,
	updateChatUnreadCount,
} from 'src/Store/ChatStore';
import {
	getContact,
	resolveJidFromLid,
	resolveLidFromJid,
} from 'src/Store/ContactStore';
import {
	getMessageCountByContact,
	getMessage,
	getRecentChatMessages,
	getRecentChatMessagesWithMedia,
	getRecentStatusMessagesWithMedia,
	getStatusContactSummaries,
} from 'src/Store/MessageStore';
import { getChatMetadata, getChatOrder } from 'src/Store/MetadataStore';
import { isGroupChatId, isGroupLikeChatId } from 'src/util/chat';

export const createResourceGatheres = (
	boundary: ReturnType<typeof initBoundary>,
	baileys: ReturnType<typeof baileysFunctions>
) => {
	const onAskResource = (
		resourceName: string,
		getterFn: (data: any) => unknown,
		timeoutMs = 8000
	) => {
		boundary.onAskResource(resourceName, async data => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const startedAt = Date.now();
			const shouldAlwaysLog =
				resourceName === 'recent_chat_messages' ||
				resourceName === 'recent_chat_messages_with_media';
			const describeRequest = () => {
				if (
					resourceName === 'recent_chat_messages' ||
					resourceName === 'recent_chat_messages_with_media'
				) {
					return ` chatId=${data?.chatId ?? 'unknown'} limit=${
						data?.limit ?? 'default'
					} exclude=${data?.excludeMessageId ?? 'none'}`;
				}

				return '';
			};
			if (shouldAlwaysLog) {
				console.log(`[Resource] ${resourceName} started${describeRequest()}`);
			}

			try {
				const response = await Promise.race([
					Promise.resolve(getterFn(data)),
					new Promise(resolve => {
						timeout = setTimeout(() => resolve(undefined), timeoutMs);
					}),
				]);

				const durationMs = Date.now() - startedAt;
				if (shouldAlwaysLog || durationMs > 500) {
					const size = Array.isArray(response) ? response.length : 'n/a';
					console.log(
						`[Resource] ${resourceName} completed durationMs=${durationMs} size=${size}${describeRequest()}`
					);
				}

				return response;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.warn(`[Resource] ${resourceName} failed: ${message}`);
				return undefined;
			} finally {
				if (timeout) {
					clearTimeout(timeout);
				}
			}
		});
	};

	const _getProfilePicUrl = async ({
		id,
		type = 'preview',
	}: {
		id: string;
		type?: 'preview' | 'image';
	}) => {
		if (!id) {
			return console.warn('Tried to fetch profile pic but no ID was provided!');
		}

		if (!Context.get('ready')) {
			return undefined;
		}

		const picUrl = await baileys.getProfilePic(id, type);
		return picUrl;
	};

	const _getGroupChatInfo = async ({ id }: { id: string }) => {
		if (!id) {
			return console.warn('Tried to fetch group chat info but no ID was provided');
		}
		if (!isGroupLikeChatId(id)) {
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
		if (!isGroupChatId(id)) {
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

	const _getChatOrder = (limit = 0) => {
		const hostData = Context.get('hostData');
		const hostIds = new Set(
			[hostData.id, hostData.lid].filter(Boolean) as string[]
		);

		return getChatOrder(limit)?.filter(chat => !hostIds.has(chat.id)) ?? [];
	};

	const getCanonicalChatId = async (chatId: string) => {
		if (isGroupLikeChatId(chatId)) {
			return chatId;
		}

		if (chatId.endsWith('@lid')) {
			return (await resolveJidFromLid(chatId)) ?? chatId;
		}

		return chatId;
	};

	const getDedupedChatOrder = async (limit = 0) => {
		const chatOrder = _getChatOrder(limit);
		const dedupedChats = new Map<string, (typeof chatOrder)[number]>();

		for (const chat of chatOrder) {
			const canonicalId = await getCanonicalChatId(chat.id);
			const currentChat = dedupedChats.get(canonicalId);

			if (!currentChat) {
				dedupedChats.set(canonicalId, {
					...chat,
					id: canonicalId,
				});
				continue;
			}

			const currentTimestamp = currentChat.lastMessageTimestamp ?? 0;
			const nextTimestamp = chat.lastMessageTimestamp ?? 0;
			const nextUnreadCount =
				(currentChat.unreadCount ?? 0) + (chat.unreadCount ?? 0);

			dedupedChats.set(canonicalId, {
				...(nextTimestamp > currentTimestamp ? chat : currentChat),
				id: canonicalId,
				unreadCount: nextUnreadCount,
				lastMessageTimestamp: Math.max(currentTimestamp, nextTimestamp),
			});
		}

		return Array.from(dedupedChats.values()).sort(
			(a, b) => (b.lastMessageTimestamp ?? 0) - (a.lastMessageTimestamp ?? 0)
		);
	};

	const _getChatSidebarList = async (limit = 0) => {
		const chatOrder = await getDedupedChatOrder(limit);

		return Promise.all(
			chatOrder.map(async metadata => ({
				...metadata,
				details: await getChatDetails(metadata.id),
				unreadCount: metadata.unreadCount ?? (await getUnreadCount(metadata.id)),
			}))
		);
	};

	const _getContactInfo = async ({ id }: { id: string }) => {
		if (!id) {
			return console.warn('Tried to fetch contact info but no ID was provided');
		}
		if (isGroupLikeChatId(id)) {
			return console.warn('Tried to fetch contact info but got an invalid ID:', id);
		}

		const contactInfo = await getContact(id);
		return contactInfo;
	};

	const _getLidFromJid = async ({ id }: { id: string }) => {
		if (!id) {
			return console.warn('Tried to resolve LID but no JID was provided');
		}

		const lid = await resolveLidFromJid(id);
		return {
			id,
			lid,
		};
	};

	const _getJidFromLid = async ({ id }: { id: string }) => {
		if (!id) {
			return console.warn('Tried to resolve JID but no LID was provided');
		}

		const jid = await resolveJidFromLid(id);
		return {
			id,
			jid,
		};
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

	const _getRecentChatMessagesWithMedia = async ({
		chatId,
		limit,
		excludeMessageId,
	}: {
		chatId?: string;
		limit?: number;
		excludeMessageId?: string;
	}) => {
		if (!chatId) {
			return console.warn(
				'Tried to fetch recent messages with media but no chatId was provided'
			);
		}

		return getRecentChatMessagesWithMedia({ chatId, limit, excludeMessageId });
	};

	const _getPinnedMessage = async ({ chatId }: { chatId?: string }) => {
		if (!chatId) {
			return console.warn('Tried to fetch pinned message but no chatId was provided');
		}

		const metadata = getChatMetadata(chatId);
		if (!metadata?.pinnedMessageId) {
			return null;
		}

		return getMessage(metadata.pinnedMessageId);
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

	const _getStatusContacts = (limit = 200) => {
		return getStatusContactSummaries(limit);
	};

	const _getStatusMessages = ({
		contactId,
		limit,
	}: {
		contactId?: string;
		limit?: number;
	}) => {
		if (!contactId) {
			return console.warn('Tried to fetch status messages but no contactId was provided');
		}

		return getRecentStatusMessagesWithMedia({ contactId, limit });
	};

	const markUnreadCountAsRead = async (chatId: string) => {
		const alias = chatId.endsWith('@lid')
			? await resolveJidFromLid(chatId)
			: chatId.endsWith('@s.whatsapp.net')
				? await resolveLidFromJid(chatId)
				: null;
		const chatIds = [chatId, alias].filter(
			(id, index, ids): id is string => !!id && ids.indexOf(id) === index
		);

		await Promise.all(chatIds.map(id => updateChatUnreadCount(id, 0)));
	};

	const _chatRead = async ({
		chatId,
		messageIds,
	}: {
		chatId?: string;
		messageIds?: string[];
	}) => {
		if (!chatId && (!Array.isArray(messageIds) || !messageIds.length)) {
			return console.warn(
				'Tried to mark chat read but no chatId or messageIds were provided'
			);
		}

		if (chatId) {
			await markUnreadCountAsRead(chatId);
		}

		if (!Array.isArray(messageIds) || !messageIds.length) {
			return { read: 0 };
		}

		return baileys.readMessages(messageIds);
	};

	onAskResource('contact_profile_pic', _getProfilePicUrl, 12000);
	onAskResource('group_chat_info', _getGroupChatInfo);
	onAskResource('group_admin_list', _groupAdminList);
	onAskResource('unread_count', _getUnreadCount);
	onAskResource('chat_details', _getChatDetails);
	onAskResource('contact_info', _getContactInfo);
	onAskResource('lid_from_jid', _getLidFromJid);
	onAskResource('jid_from_lid', _getJidFromLid);
	onAskResource('chat_order', getDedupedChatOrder);
	onAskResource('chat_sidebar_list', _getChatSidebarList);
	onAskResource('chat_status', _chatStatus);
	onAskResource('all_groups', _getAllGroups);
	onAskResource('all_private_chats', _getAllPrivateChats);
	onAskResource('recent_chat_messages', _getRecentChatMessages);
	onAskResource(
		'recent_chat_messages_with_media',
		_getRecentChatMessagesWithMedia
	);
	onAskResource('pinned_message', _getPinnedMessage);
	onAskResource('message_count', _getMessageCount);
	onAskResource('status_contacts', _getStatusContacts);
	onAskResource('status_messages', _getStatusMessages);
	onAskResource('chat_read', _chatRead);
};
