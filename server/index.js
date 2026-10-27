const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const http = require('http');
const { WebSocketServer } = require('ws');
const { readJSON, writeJSON, USERS_FILE, MESSAGES_FILE, WALLPAPERS_FILE, GROUPS_FILE } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ==================== API ====================

app.post('/api/register', async (req, res) => {
    try {
        const { name, nickname, phone, email, password, passwordConfirm, device } = req.body;
        if (!name || !nickname || !phone || !email || !password) return res.status(400).json({ ok: false, error: 'Заполните все поля' });
        if (password !== passwordConfirm) return res.status(400).json({ ok: false, error: 'Пароли не совпадают' });
        
        const users = readJSON(USERS_FILE, []);
        const emailCount = users.filter(u => u.email.toLowerCase() === email.toLowerCase()).length;
        if (emailCount >= 3) return res.status(400).json({ ok: false, error: 'На эту почту уже зарегистрировано 3 аккаунта (максимум)' });
        if (users.find(u => u.nickname.toLowerCase() === nickname.toLowerCase())) return res.status(400).json({ ok: false, error: 'Этот ник занят' });

        const passwordHash = await bcrypt.hash(password, 10);
        
        const sysBotId = 'system_bot';
        let systemBot = users.find(u => u.id === sysBotId);
        if (!systemBot) {
            systemBot = { id: sysBotId, name: 'MAX Support', nickname: 'MAX Support', friends: [], avatar: null, bio: 'Официальный бот', hideStatus: true };
            users.push(systemBot);
        }

        const newUser = {
            id: Date.now().toString(), name, nickname, phone, email, passwordHash, device: device || 'desktop',
            friends: [sysBotId], banned: [], avatar: null, bio: '', hidePhone: false, hideStatus: false, lastSeen: new Date().toISOString(), theme: 'dark'
        };
        users.push(newUser);
        writeJSON(USERS_FILE, users);
        
        const messages = readJSON(MESSAGES_FILE, []);
        messages.push({
            id: Date.now().toString() + 'welcome',
            from: sysBotId,
            to: newUser.id,
            text: '👋 Добро пожаловать в MAX Messenger!\n\nЗдесь вы можете общаться с друзьями, создавать группы, отправлять фото, голосовые и видеокружочки.\n\nПравила платформы:\n1. Будьте вежливы.\n2. Не спамьте.\n3. Уважайте друг друга.\n\nПриятного общения!',
            createdAt: new Date().toISOString()
        });
        writeJSON(MESSAGES_FILE, messages);

        res.json({ ok: true, message: 'Успешно!', userId: newUser.id });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { login, password } = req.body;
        const users = readJSON(USERS_FILE, []);
        const user = users.find(u => u.nickname.toLowerCase() === login.toLowerCase() || u.email.toLowerCase() === login.toLowerCase());
        if (!user) return res.status(400).json({ ok: false, error: 'Не найден' });
        if (!(await bcrypt.compare(password, user.passwordHash))) return res.status(400).json({ ok: false, error: 'Неверный пароль' });
        
        if (!user.friends) user.friends = [];
        if (!user.banned) user.banned = [];
        
        const sysBotId = 'system_bot';
        if (!user.friends.includes(sysBotId)) {
            user.friends.push(sysBotId);
        }

        user.lastSeen = new Date().toISOString();
        writeJSON(USERS_FILE, users);
        res.json({ ok: true, user: { ...user, passwordHash: undefined } });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка' }); }
});

app.post('/api/profile/update', async (req, res) => {
    const { userId, name, nickname, bio, phone, hidePhone, hideStatus, avatar, theme } = req.body;
    const users = readJSON(USERS_FILE, []);
    const me = users.find(u => u.id === userId);
    if (!me) return res.status(400).json({ ok: false });

    if (nickname && nickname !== me.nickname) {
        if (users.find(u => u.id !== userId && u.nickname.toLowerCase() === nickname.toLowerCase())) return res.status(400).json({ ok: false, error: 'Ник занят' });
        me.nickname = nickname;
    }
    if (name) me.name = name;
    if (bio !== undefined) me.bio = bio;
    if (phone !== undefined) me.phone = phone;
    if (hidePhone !== undefined) me.hidePhone = hidePhone;
    if (hideStatus !== undefined) me.hideStatus = hideStatus;
    if (avatar !== undefined) me.avatar = avatar;
    if (theme !== undefined) me.theme = theme;

    writeJSON(USERS_FILE, users);
    res.json({ ok: true, user: { ...me, passwordHash: undefined } });
});

app.post('/api/profile/change-password', async (req, res) => {
    const { userId, oldPassword, newPassword } = req.body;
    const users = readJSON(USERS_FILE, []);
    const me = users.find(u => u.id === userId);
    if (!me) return res.status(400).json({ ok: false });

    const isMatch = await bcrypt.compare(oldPassword, me.passwordHash);
    if (!isMatch) return res.status(400).json({ ok: false, error: 'Старый пароль неверен' });

    me.passwordHash = await bcrypt.hash(newPassword, 10);
    writeJSON(USERS_FILE, users);
    res.json({ ok: true, message: 'Пароль изменён!' });
});

// --- ДРУЗЬЯ (МГНОВЕННОЕ ДОБАВЛЕНИЕ) ---

app.get('/api/users/search', (req, res) => {
    const q = (req.query.q || '').toLowerCase();
    const users = readJSON(USERS_FILE, []);
    const found = users.filter(u => u.id !== req.query.myId && u.id !== 'system_bot' && (u.nickname.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)));
    res.json({ ok: true, users: found.map(u => ({ ...u, passwordHash: undefined })) });
});

app.post('/api/friends/add', (req, res) => {
    const { userId, friendId } = req.body;
    const users = readJSON(USERS_FILE, []);
    const me = users.find(u => u.id === userId);
    const friend = users.find(u => u.id === friendId);
    
    if (!me || !friend) return res.json({ ok: false, error: 'Пользователь не найден' });
    if (me.friends.includes(friendId)) return res.json({ ok: false, error: 'Уже в друзьях' });

    me.friends.push(friendId);
    if (!friend.friends) friend.friends = [];
    if (!friend.friends.includes(userId)) friend.friends.push(userId);

    writeJSON(USERS_FILE, users);
    res.json({ ok: true, message: 'Друг добавлен' });
});

app.get('/api/friends', (req, res) => {
    const users = readJSON(USERS_FILE, []);
    const me = users.find(u => u.id === req.query.userId);
    if (!me) return res.json({ ok: false });
    const friends = users.filter(u => me.friends && me.friends.includes(u.id)).map(u => ({ ...u, passwordHash: undefined }));
    res.json({ ok: true, friends });
});

app.post('/api/friends/remove', (req, res) => {
    const { userId, friendId } = req.body;
    const users = readJSON(USERS_FILE, []);
    const me = users.find(u => u.id === userId);
    const friend = users.find(u => u.id === friendId);
    if (!me || !friend) return res.json({ ok: false });
    
    me.friends = me.friends.filter(id => id !== friendId);
    if (friend.friends) friend.friends = friend.friends.filter(id => id !== userId);
    writeJSON(USERS_FILE, users);
    res.json({ ok: true });
});

// --- ГРУППЫ ---

app.post('/api/groups/create', (req, res) => {
    const { creatorId, name, memberIds } = req.body;
    const groups = readJSON(GROUPS_FILE, []);
    const newGroup = {
        id: 'grp_' + Date.now().toString(),
        name: name || 'Без названия',
        creatorId: creatorId,
        members: [creatorId, ...(memberIds || [])],
        avatar: null
    };
    groups.push(newGroup);
    writeJSON(GROUPS_FILE, groups);
    res.json({ ok: true, group: newGroup });
});

app.get('/api/groups', (req, res) => {
    const groups = readJSON(GROUPS_FILE, []);
    const myGroups = groups.filter(g => g.members.includes(req.query.userId));
    res.json({ ok: true, groups: myGroups });
});

app.get('/api/group-messages', (req, res) => {
    const { groupId } = req.query;
    const messages = readJSON(MESSAGES_FILE, []);
    const groupMsgs = messages.filter(m => m.to === groupId);
    res.json({ ok: true, messages: groupMsgs });
});

// --- СООБЩЕНИЯ ---

app.get('/api/messages', (req, res) => {
    const { user1, user2 } = req.query;
    const messages = readJSON(MESSAGES_FILE, []);
    const dialog = messages.filter(m => (m.from === user1 && m.to === user2) || (m.from === user2 && m.to === user1));
    res.json({ ok: true, messages: dialog });
});

app.post('/api/messages/delete', (req, res) => {
    const { messageId, userId } = req.body;
    let messages = readJSON(MESSAGES_FILE, []);
    const msg = messages.find(m => m.id === messageId);
    if (!msg || msg.from !== userId) return res.json({ ok: false });

    messages = messages.filter(m => m.id !== messageId);
    writeJSON(MESSAGES_FILE, messages);

    const payload = JSON.stringify({ type: 'message_deleted', messageId });
    const recipientWs = clients.get(msg.to);
    if (recipientWs && recipientWs.readyState === 1) recipientWs.send(payload);
    const senderWs = clients.get(msg.from);
    if (senderWs && senderWs.readyState === 1) senderWs.send(payload);

    res.json({ ok: true });
});

app.get('/api/wallpaper', (req, res) => {
    const { userId, chatId } = req.query;
    const walls = readJSON(WALLPAPERS_FILE, {});
    res.json({ ok: true, wallpaper: walls[`${userId}_${chatId}`] || null });
});

app.post('/api/wallpaper', (req, res) => {
    const { userId, chatId, wallpaper } = req.body;
    const walls = readJSON(WALLPAPERS_FILE, {});
    const key = `${userId}_${chatId}`;
    if (!wallpaper) delete walls[key]; else walls[key] = wallpaper;
    writeJSON(WALLPAPERS_FILE, walls);
    res.json({ ok: true, wallpaper: walls[key] || null });
});

// ==================== WebSocket ====================
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Map();

wss.on('connection', (ws) => {
    let userId = null;
    ws.on('message', (raw) => {
        let data; try { data = JSON.parse(raw.toString()); } catch { return; }
        
        if (data.type === 'auth') {
            userId = data.userId;
            clients.set(userId, ws);
            broadcastOnlineStatus(userId, true);
        }

        if (data.type === 'typing') {
            const targetWs = clients.get(data.to);
            if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: 'user_typing', from: data.from }));
        }

        if (data.type === 'message') {
            const { from, to, text, image, audio, video, forwarded } = data;
            const messages = readJSON(MESSAGES_FILE, []);
            const msg = { id: Date.now().toString(), from, to, text: text || '', image: image || null, audio: audio || null, video: video || null, forwarded: forwarded || null, createdAt: new Date().toISOString(), status: 'sent' };
            messages.push(msg);
            writeJSON(MESSAGES_FILE, messages);
            
            const recipientWs = clients.get(to);
            if (recipientWs && recipientWs.readyState === 1) {
                msg.status = 'read';
                writeJSON(MESSAGES_FILE, messages);
                recipientWs.send(JSON.stringify({ type: 'new_message', message: msg }));
            }
            ws.send(JSON.stringify({ type: 'message_sent', message: msg }));
        }

        if (data.type === 'group_message') {
            const { from, to, text, image, audio, video } = data;
            const messages = readJSON(MESSAGES_FILE, []);
            const msg = { id: Date.now().toString(), from, to, text: text || '', image: image || null, audio: audio || null, video: video || null, createdAt: new Date().toISOString() };
            messages.push(msg);
            writeJSON(MESSAGES_FILE, messages);
            
            const groups = readJSON(GROUPS_FILE, []);
            const group = groups.find(g => g.id === to);
            if (group) {
                group.members.forEach(memberId => {
                    if (memberId === from) return;
                    const memberWs = clients.get(memberId);
                    if (memberWs && memberWs.readyState === 1) memberWs.send(JSON.stringify({ type: 'new_message', message: msg }));
                });
            }
            ws.send(JSON.stringify({ type: 'message_sent', message: msg }));
        }

        if (data.type === 'react_message') {
            const { messageId, emoji, from } = data;
            const messages = readJSON(MESSAGES_FILE, []);
            const msg = messages.find(m => m.id === messageId);
            if (msg) {
                if (!msg.reactions) msg.reactions = {};
                if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
                const idx = msg.reactions[emoji].indexOf(from);
                if (idx > -1) msg.reactions[emoji].splice(idx, 1);
                else msg.reactions[emoji].push(from);
                writeJSON(MESSAGES_FILE, messages);
                
                const payload = JSON.stringify({ type: 'message_reacted', messageId, reactions: msg.reactions });
                ws.send(payload);
                const other = msg.from === from ? msg.to : msg.from;
                const otherWs = clients.get(other);
                if (otherWs && otherWs.readyState === 1) otherWs.send(payload);
            }
        }

        if (data.type === 'call_offer') {
            const targetWs = clients.get(data.to);
            if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: 'call_incoming', from: data.from, fromName: data.fromName }));
        }
        if (data.type === 'call_accept') {
            const targetWs = clients.get(data.to);
            if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: 'call_accepted', from: data.from }));
        }
        if (data.type === 'call_reject') {
            const targetWs = clients.get(data.to);
            if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: 'call_rejected', from: data.from }));
        }
        if (data.type === 'call_end') {
            const targetWs = clients.get(data.to);
            if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: 'call_ended', from: data.from }));
        }
    });
    
    ws.on('close', () => { 
        if (userId) {
            clients.delete(userId);
            broadcastOnlineStatus(userId, false);
        }
    });
});

function broadcastOnlineStatus(changedUserId, isOnline) {
    const users = readJSON(USERS_FILE, []);
    const changedUser = users.find(u => u.id === changedUserId);
    if (!changedUser) return;

    if (!isOnline) {
        changedUser.lastSeen = new Date().toISOString();
        writeJSON(USERS_FILE, users);
    }

    if (!changedUser.friends) return;

    changedUser.friends.forEach(friendId => {
        const friendWs = clients.get(friendId);
        if (friendWs && friendWs.readyState === 1) {
            friendWs.send(JSON.stringify({ 
                type: 'user_status_changed', 
                userId: changedUserId, 
                isOnline: isOnline,
                lastSeen: changedUser.lastSeen,
                hideStatus: changedUser.hideStatus
            }));
        }
    });
}

server.listen(PORT, '0.0.0.0', () => console.log('✅ Сервер запущен'));