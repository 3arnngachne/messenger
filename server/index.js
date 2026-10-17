// server/server.js — сервер мессенджера

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const http = require('http');
const { WebSocketServer } = require('ws');
const { readJSON, writeJSON, USERS_FILE, MESSAGES_FILE, GROUPS_FILE, WALLPAPERS_FILE } = require('./db');

const app = express();
// ВАЖНО: Render сам выдает порт через переменную окружения. 
// Если ее нет (локально), используем 3000.
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '15mb' })); 
app.use(express.static(path.join(__dirname, '../public')));

// ==================== HTTP API ====================

app.post('/api/register', async (req, res) => {
    try {
        const { name, nickname, phone, email, password, passwordConfirm } = req.body;
        if (!name || !nickname || !phone || !email || !password || !passwordConfirm) return res.status(400).json({ ok: false, error: 'Заполните все поля' });
        if (password !== passwordConfirm) return res.status(400).json({ ok: false, error: 'Пароли не совпадают' });
        if (password.length < 6) return res.status(400).json({ ok: false, error: 'Пароль минимум 6 символов' });
        const digitsOnly = String(phone).replace(/\D/g, '');
        if (digitsOnly.length < 10 || digitsOnly.length > 15) return res.status(400).json({ ok: false, error: 'Неверный формат телефона' });

        const users = readJSON(USERS_FILE, []);
        if (users.find(u => u.nickname.toLowerCase() === nickname.toLowerCase())) return res.status(400).json({ ok: false, error: 'Этот ник уже занят' });
        if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(400).json({ ok: false, error: 'Эта почта уже зарегистрирована' });

        const passwordHash = await bcrypt.hash(password, 10);
        const newUser = {
            id: Date.now().toString(), name: name.trim(), nickname: nickname.trim(),
            phone: String(phone).trim(), email: email.trim().toLowerCase(),
            passwordHash, friends: [], avatar: null, createdAt: new Date().toISOString()
        };
        users.push(newUser);
        writeJSON(USERS_FILE, users);
        res.json({ ok: true, message: 'Регистрация успешна!', userId: newUser.id });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { login, password } = req.body;
        if (!login || !password) return res.status(400).json({ ok: false, error: 'Введите логин и пароль' });
        const users = readJSON(USERS_FILE, []);
        const user = users.find(u => u.nickname.toLowerCase() === login.toLowerCase() || u.email.toLowerCase() === login.toLowerCase());
        if (!user) return res.status(400).json({ ok: false, error: 'Пользователь не найден' });
        const passwordOk = await bcrypt.compare(password, user.passwordHash);
        if (!passwordOk) return res.status(400).json({ ok: false, error: 'Неверный пароль' });
        res.json({
            ok: true, message: 'Вход выполнен',
            user: { id: user.id, name: user.name, nickname: user.nickname, phone: user.phone || '', email: user.email, avatar: user.avatar || null }
        });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.post('/api/profile/update', (req, res) => {
    try {
        const { userId, name, nickname, phone } = req.body;
        if (!userId || !name || !nickname || !name.trim() || !nickname.trim()) return res.status(400).json({ ok: false, error: 'Заполните все поля' });
        let phoneDigits = '';
        if (phone !== undefined && phone !== null && String(phone).trim() !== '') {
            phoneDigits = String(phone).replace(/\D/g, '');
            if (phoneDigits.length < 10 || phoneDigits.length > 15) return res.status(400).json({ ok: false, error: 'Неверный формат телефона' });
        }
        const users = readJSON(USERS_FILE, []);
        const me = users.find(u => u.id === userId);
        if (!me) return res.status(400).json({ ok: false, error: 'Пользователь не найден' });
        if (users.find(u => u.id !== userId && u.nickname.toLowerCase() === nickname.trim().toLowerCase())) return res.status(400).json({ ok: false, error: 'Этот ник уже занят' });
        me.name = name.trim();
        me.nickname = nickname.trim();
        if (phone !== undefined) me.phone = String(phone).trim();
        writeJSON(USERS_FILE, users);
        res.json({ ok: true, message: 'Профиль сохранён', user: { id: me.id, name: me.name, nickname: me.nickname, phone: me.phone || '', email: me.email, avatar: me.avatar || null } });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.post('/api/profile/change-password', async (req, res) => {
    try {
        const { userId, oldPassword, newPassword, newPasswordConfirm } = req.body;
        if (!userId || !oldPassword || !newPassword || !newPasswordConfirm) return res.status(400).json({ ok: false, error: 'Заполните все поля' });
        if (newPassword !== newPasswordConfirm) return res.status(400).json({ ok: false, error: 'Новые пароли не совпадают' });
        if (newPassword.length < 6) return res.status(400).json({ ok: false, error: 'Новый пароль минимум 6 символов' });
        const users = readJSON(USERS_FILE, []);
        const me = users.find(u => u.id === userId);
        if (!me) return res.status(400).json({ ok: false, error: 'Пользователь не найден' });
        const oldOk = await bcrypt.compare(oldPassword, me.passwordHash);
        if (!oldOk) return res.status(400).json({ ok: false, error: 'Неверный старый пароль' });
        me.passwordHash = await bcrypt.hash(newPassword, 10);
        writeJSON(USERS_FILE, users);
        res.json({ ok: true, message: 'Пароль успешно изменён' });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.post('/api/profile/avatar', (req, res) => {
    try {
        const { userId, avatar } = req.body;
        if (!userId) return res.status(400).json({ ok: false, error: 'Нет userId' });
        if (avatar !== null && typeof avatar !== 'string') return res.status(400).json({ ok: false, error: 'Неверный формат' });
        const users = readJSON(USERS_FILE, []);
        const me = users.find(u => u.id === userId);
        if (!me) return res.status(400).json({ ok: false, error: 'Пользователь не найден' });
        me.avatar = avatar || null;
        writeJSON(USERS_FILE, users);
        res.json({ ok: true, message: 'Аватар сохранён', avatar: me.avatar });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

// ==================== ОБОИ ====================
app.get('/api/wallpaper', (req, res) => {
    try {
        const { userId, chatId } = req.query;
        if (!userId || !chatId) return res.status(400).json({ ok: false, error: 'Нет параметров' });
        const walls = readJSON(WALLPAPERS_FILE, {});
        res.json({ ok: true, wallpaper: walls[`${userId}_${chatId}`] || null });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.post('/api/wallpaper', (req, res) => {
    try {
        const { userId, chatId, wallpaper } = req.body;
        if (!userId || !chatId) return res.status(400).json({ ok: false, error: 'Нет параметров' });
        const walls = readJSON(WALLPAPERS_FILE, {});
        const key = `${userId}_${chatId}`;
        if (wallpaper === null || wallpaper === '') delete walls[key];
        else walls[key] = wallpaper;
        writeJSON(WALLPAPERS_FILE, walls);
        res.json({ ok: true, wallpaper: walls[key] || null });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.get('/api/users/search', (req, res) => {
    try {
        const q = (req.query.q || '').trim().toLowerCase();
        const currentUserId = req.query.currentUserId || '';
        if (!q || q.length < 2) return res.json({ ok: true, users: [] });
        const users = readJSON(USERS_FILE, []);
        const currentUser = users.find(u => u.id === currentUserId);
        const friends = currentUser ? (currentUser.friends || []) : [];
        const found = users.filter(u => u.id !== currentUserId).filter(u => !friends.includes(u.id))
            .filter(u => u.nickname.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))
            .slice(0, 20).map(u => ({ id: u.id, name: u.name, nickname: u.nickname, avatar: u.avatar || null }));
        res.json({ ok: true, users: found });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.get('/api/friends', (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId) return res.status(400).json({ ok: false, error: 'Нет userId' });
        const users = readJSON(USERS_FILE, []);
        const me = users.find(u => u.id === userId);
        if (!me) return res.status(400).json({ ok: false, error: 'Пользователь не найден' });
        const friendIds = me.friends || [];
        const friends = users.filter(u => friendIds.includes(u.id)).map(u => ({ id: u.id, name: u.name, nickname: u.nickname, avatar: u.avatar || null }));
        res.json({ ok: true, friends });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.post('/api/friends/add', (req, res) => {
    try {
        const { userId, friendId } = req.body;
        if (!userId || !friendId) return res.status(400).json({ ok: false, error: 'Не хватает данных' });
        if (userId === friendId) return res.status(400).json({ ok: false, error: 'Нельзя добавить себя' });
        const users = readJSON(USERS_FILE, []);
        const me = users.find(u => u.id === userId);
        const friend = users.find(u => u.id === friendId);
        if (!me) return res.status(400).json({ ok: false, error: 'Вы не найдены' });
        if (!friend) return res.status(400).json({ ok: false, error: 'Пользователь не найден' });
        if (!me.friends) me.friends = [];
        if (!friend.friends) friend.friends = [];
        if (me.friends.includes(friendId)) return res.status(400).json({ ok: false, error: 'Уже в друзьях' });
        me.friends.push(friendId);
        friend.friends.push(userId);
        writeJSON(USERS_FILE, users);
        res.json({ ok: true, message: `Теперь вы друзья с ${friend.nickname}`, friend: { id: friend.id, name: friend.name, nickname: friend.nickname, avatar: friend.avatar || null } });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.get('/api/messages', (req, res) => {
    try {
        const { user1, user2 } = req.query;
        if (!user1 || !user2) return res.status(400).json({ ok: false, error: 'Нет параметров' });
        const messages = readJSON(MESSAGES_FILE, []);
        const dialog = messages.filter(m => (m.from === user1 && m.to === user2) || (m.from === user2 && m.to === user1));
        res.json({ ok: true, messages: dialog });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

// ==================== ГРУППЫ ====================

app.post('/api/groups/create', (req, res) => {
    try {
        const { creatorId, name, memberIds } = req.body;
        if (!creatorId || !name || !name.trim()) return res.status(400).json({ ok: false, error: 'Введите название группы' });
        const users = readJSON(USERS_FILE, []);
        const creator = users.find(u => u.id === creatorId);
        if (!creator) return res.status(400).json({ ok: false, error: 'Создатель не найден' });
        const groups = readJSON(GROUPS_FILE, []);
        const members = [creatorId];
        if (Array.isArray(memberIds)) {
            memberIds.forEach(id => {
                if (id !== creatorId && users.find(u => u.id === id) && !members.includes(id)) members.push(id);
            });
        }
        const group = { id: 'grp_' + Date.now().toString(), name: name.trim(), creatorId, members, avatar: null, createdAt: new Date().toISOString() };
        groups.push(group);
        writeJSON(GROUPS_FILE, groups);
        res.json({ ok: true, message: `Группа "${group.name}" создана`, group });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.get('/api/groups', (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId) return res.status(400).json({ ok: false, error: 'Нет userId' });
        const groups = readJSON(GROUPS_FILE, []);
        const myGroups = groups.filter(g => g.members.includes(userId))
            .map(g => ({ id: g.id, name: g.name, creatorId: g.creatorId, members: g.members, membersCount: g.members.length, avatar: g.avatar || null }));
        res.json({ ok: true, groups: myGroups });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.get('/api/group-messages', (req, res) => {
    try {
        const { groupId } = req.query;
        if (!groupId) return res.status(400).json({ ok: false, error: 'Нет groupId' });
        const messages = readJSON(MESSAGES_FILE, []);
        const groupMsgs = messages.filter(m => m.toGroup === groupId);
        res.json({ ok: true, messages: groupMsgs });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.get('/api/groups/info', (req, res) => {
    try {
        const { groupId, userId } = req.query;
        if (!groupId || !userId) return res.status(400).json({ ok: false, error: 'Нет параметров' });
        const groups = readJSON(GROUPS_FILE, []);
        const group = groups.find(g => g.id === groupId);
        if (!group) return res.status(400).json({ ok: false, error: 'Группа не найдена' });
        if (!group.members.includes(userId)) return res.status(403).json({ ok: false, error: 'Нет доступа' });
        const users = readJSON(USERS_FILE, []);
        const memberData = group.members.map(id => {
            const u = users.find(x => x.id === id);
            return u ? { id: u.id, name: u.name, nickname: u.nickname, avatar: u.avatar || null, isCreator: u.id === group.creatorId } : null;
        }).filter(Boolean);
        res.json({
            ok: true,
            group: { id: group.id, name: group.name, creatorId: group.creatorId, avatar: group.avatar || null, members: memberData, membersCount: group.members.length }
        });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.post('/api/groups/rename', (req, res) => {
    try {
        const { groupId, userId, newName } = req.body;
        if (!groupId || !userId || !newName || !newName.trim()) return res.status(400).json({ ok: false, error: 'Заполните поля' });
        const groups = readJSON(GROUPS_FILE, []);
        const group = groups.find(g => g.id === groupId);
        if (!group) return res.status(400).json({ ok: false, error: 'Группа не найдена' });
        if (group.creatorId !== userId) return res.status(403).json({ ok: false, error: 'Только создатель может менять название' });
        group.name = newName.trim();
        writeJSON(GROUPS_FILE, groups);
        notifyGroupUpdated(group.id, { name: group.name, membersCount: group.members.length, avatar: group.avatar || null });
        res.json({ ok: true, message: 'Название изменено' });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.post('/api/groups/avatar', (req, res) => {
    try {
        const { groupId, userId, avatar } = req.body;
        if (!groupId || !userId) return res.status(400).json({ ok: false, error: 'Нет параметров' });
        if (avatar !== null && typeof avatar !== 'string') return res.status(400).json({ ok: false, error: 'Неверный формат' });
        const groups = readJSON(GROUPS_FILE, []);
        const group = groups.find(g => g.id === groupId);
        if (!group) return res.status(400).json({ ok: false, error: 'Группа не найдена' });
        if (group.creatorId !== userId) return res.status(403).json({ ok: false, error: 'Только создатель может менять аватар' });

        group.avatar = avatar || null;
        writeJSON(GROUPS_FILE, groups);
        notifyGroupUpdated(group.id, { name: group.name, membersCount: group.members.length, avatar: group.avatar });
        res.json({ ok: true, message: 'Аватар группы сохранён', avatar: group.avatar });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.post('/api/groups/add-member', (req, res) => {
    try {
        const { groupId, userId, newMemberId } = req.body;
        if (!groupId || !userId || !newMemberId) return res.status(400).json({ ok: false, error: 'Заполните поля' });
        const groups = readJSON(GROUPS_FILE, []);
        const group = groups.find(g => g.id === groupId);
        if (!group) return res.status(400).json({ ok: false, error: 'Группа не найдена' });
        if (group.creatorId !== userId) return res.status(403).json({ ok: false, error: 'Только создатель может добавлять' });
        if (group.members.includes(newMemberId)) return res.status(400).json({ ok: false, error: 'Уже в группе' });
        const users = readJSON(USERS_FILE, []);
        const newUser = users.find(u => u.id === newMemberId);
        if (!newUser) return res.status(400).json({ ok: false, error: 'Пользователь не найден' });
        group.members.push(newMemberId);
        writeJSON(GROUPS_FILE, groups);
        notifyGroupUpdated(group.id, { name: group.name, membersCount: group.members.length, avatar: group.avatar || null });
        notifyUser(newMemberId, { type: 'added_to_group', group: { id: group.id, name: group.name, creatorId: group.creatorId, membersCount: group.members.length, avatar: group.avatar || null } });
        res.json({ ok: true, message: `${newUser.nickname} добавлен`, member: { id: newUser.id, name: newUser.name, nickname: newUser.nickname, avatar: newUser.avatar || null, isCreator: false } });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.post('/api/groups/remove-member', (req, res) => {
    try {
        const { groupId, userId, memberId } = req.body;
        if (!groupId || !userId || !memberId) return res.status(400).json({ ok: false, error: 'Заполните поля' });
        const groups = readJSON(GROUPS_FILE, []);
        const group = groups.find(g => g.id === groupId);
        if (!group) return res.status(400).json({ ok: false, error: 'Группа не найдена' });
        if (group.creatorId !== userId) return res.status(403).json({ ok: false, error: 'Только создатель' });
        if (memberId === group.creatorId) return res.status(400).json({ ok: false, error: 'Нельзя удалить создателя' });
        if (!group.members.includes(memberId)) return res.status(400).json({ ok: false, error: 'Его нет в группе' });
        group.members = group.members.filter(id => id !== memberId);
        writeJSON(GROUPS_FILE, groups);
        notifyGroupUpdated(group.id, { name: group.name, membersCount: group.members.length, avatar: group.avatar || null });
        notifyUser(memberId, { type: 'removed_from_group', groupId: group.id });
        res.json({ ok: true, message: 'Участник удалён' });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.post('/api/groups/leave', (req, res) => {
    try {
        const { groupId, userId } = req.body;
        if (!groupId || !userId) return res.status(400).json({ ok: false, error: 'Заполните поля' });
        const groups = readJSON(GROUPS_FILE, []);
        const group = groups.find(g => g.id === groupId);
        if (!group) return res.status(400).json({ ok: false, error: 'Группа не найдена' });
        if (group.creatorId === userId) return res.status(400).json({ ok: false, error: 'Создатель не может выйти' });
        if (!group.members.includes(userId)) return res.status(400).json({ ok: false, error: 'Вас нет в группе' });
        group.members = group.members.filter(id => id !== userId);
        writeJSON(GROUPS_FILE, groups);
        notifyGroupUpdated(group.id, { name: group.name, membersCount: group.members.length, avatar: group.avatar || null });
        res.json({ ok: true, message: 'Вы вышли из группы' });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.get('/api/ping', (req, res) => { res.json({ ok: true, message: 'Сервер работает!' }); });

// ==================== WebSocket ====================

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Map();

function notifyGroupUpdated(groupId, data) {
    const groups = readJSON(GROUPS_FILE, []);
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    const payload = JSON.stringify({ type: 'group_updated', groupId, group: data });
    group.members.forEach(memberId => {
        const set = clients.get(memberId);
        if (set) set.forEach(s => { if (s.readyState === 1) s.send(payload); });
    });
}

function notifyUser(userId, data) {
    const set = clients.get(userId);
    if (set) set.forEach(s => { if (s.readyState === 1) s.send(JSON.stringify(data)); });
}

wss.on('connection', (ws) => {
    let userId = null;

    ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); } catch { return; }

        if (data.type === 'auth') {
            userId = data.userId;
            if (!clients.has(userId)) clients.set(userId, new Set());
            clients.get(userId).add(ws);
            return;
        }

        if (data.type === 'message') {
            const { from, to, text, image } = data;
            if (!from || !to || (!text && !image)) return;
            const messages = readJSON(MESSAGES_FILE, []);
            const msg = { id: Date.now().toString() + Math.random().toString(36).slice(2, 7), from, to, text: text ? text.trim() : '', image: image || null, createdAt: new Date().toISOString(), editedAt: null };
            messages.push(msg);
            writeJSON(MESSAGES_FILE, messages);
            const recipientSet = clients.get(to);
            if (recipientSet) recipientSet.forEach(sock => { if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'new_message', message: msg })); });
            ws.send(JSON.stringify({ type: 'message_sent', message: msg }));
            return;
        }

        if (data.type === 'group_message') {
            const { from, groupId, text, image } = data;
            if (!from || !groupId || (!text && !image)) return;
            const groups = readJSON(GROUPS_FILE, []);
            const group = groups.find(g => g.id === groupId);
            if (!group || !group.members.includes(from)) return;
            const messages = readJSON(MESSAGES_FILE, []);
            const msg = { id: Date.now().toString() + Math.random().toString(36).slice(2, 7), from, toGroup: groupId, text: text ? text.trim() : '', image: image || null, createdAt: new Date().toISOString(), editedAt: null };
            messages.push(msg);
            writeJSON(MESSAGES_FILE, messages);
            group.members.forEach(memberId => {
                if (memberId === from) return;
                const memberSet = clients.get(memberId);
                if (memberSet) memberSet.forEach(sock => { if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'new_group_message', message: msg })); });
            });
            ws.send(JSON.stringify({ type: 'group_message_sent', message: msg }));
            return;
        }

        if (data.type === 'edit_message') {
            const { messageId, newText, from } = data;
            if (!messageId || newText === undefined) return;
            const messages = readJSON(MESSAGES_FILE, []);
            const msg = messages.find(m => m.id === messageId);
            if (!msg || msg.from !== from) return;
            msg.text = (newText || '').trim();
            msg.editedAt = new Date().toISOString();
            writeJSON(MESSAGES_FILE, messages);
            const recipients = [];
            if (msg.to) recipients.push(msg.to, msg.from);
            else if (msg.toGroup) { const groups = readJSON(GROUPS_FILE, []); const group = groups.find(g => g.id === msg.toGroup); if (group) recipients.push(...group.members); }
            const payload = JSON.stringify({ type: 'message_updated', message: msg });
            recipients.forEach(uid => { const set = clients.get(uid); if (set) set.forEach(s => { if (s.readyState === 1) s.send(payload); }); });
            return;
        }

        if (data.type === 'delete_message') {
            const { messageId, from } = data;
            if (!messageId) return;
            let messages = readJSON(MESSAGES_FILE, []);
            const msg = messages.find(m => m.id === messageId);
            if (!msg || msg.from !== from) return;
            const recipients = [];
            if (msg.to) recipients.push(msg.to, msg.from);
            else if (msg.toGroup) { const groups = readJSON(GROUPS_FILE, []); const group = groups.find(g => g.id === msg.toGroup); if (group) recipients.push(...group.members); }
            messages = messages.filter(m => m.id !== messageId);
            writeJSON(MESSAGES_FILE, messages);
            const payload = JSON.stringify({ type: 'message_deleted', messageId });
            recipients.forEach(uid => { const set = clients.get(uid); if (set) set.forEach(s => { if (s.readyState === 1) s.send(payload); }); });
            return;
        }
    });

    ws.on('close', () => {
        if (userId && clients.has(userId)) {
            clients.get(userId).delete(ws);
            if (clients.get(userId).size === 0) clients.delete(userId);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен`);
    console.log(`   Локально:  http://localhost:${PORT}`);
    console.log(`   По сети:   http://<твой-IP>:${PORT}`);
    console.log(`✅ WebSocket готов`);
});