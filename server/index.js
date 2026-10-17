const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const http = require('http');
const { WebSocketServer } = require('ws');
const { readJSON, writeJSON, USERS_FILE, MESSAGES_FILE, GROUPS_FILE, WALLPAPERS_FILE } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ==================== API ====================
app.post('/api/register', async (req, res) => {
    try {
        const { name, nickname, phone, email, password, passwordConfirm } = req.body;
        if (!name || !nickname || !phone || !email || !password) return res.status(400).json({ ok: false, error: 'Заполните все поля' });
        if (password !== passwordConfirm) return res.status(400).json({ ok: false, error: 'Пароли не совпадают' });
        
        const users = readJSON(USERS_FILE, []);
        if (users.find(u => u.nickname.toLowerCase() === nickname.toLowerCase())) return res.status(400).json({ ok: false, error: 'Этот ник занят' });
        if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(400).json({ ok: false, error: 'Эта почта занята' });

        const passwordHash = await bcrypt.hash(password, 10);
        const newUser = {
            id: Date.now().toString(), name, nickname, phone, email, passwordHash,
            friends: [], banned: [], avatar: null, bio: '', hidePhone: false, hideStatus: false, lastSeen: new Date().toISOString()
        };
        users.push(newUser);
        writeJSON(USERS_FILE, users);
        res.json({ ok: true, message: 'Успешно!' });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка сервера' }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { login, password } = req.body;
        const users = readJSON(USERS_FILE, []);
        const user = users.find(u => u.nickname.toLowerCase() === login.toLowerCase() || u.email.toLowerCase() === login.toLowerCase());
        if (!user) return res.status(400).json({ ok: false, error: 'Не найден' });
        if (!(await bcrypt.compare(password, user.passwordHash))) return res.status(400).json({ ok: false, error: 'Неверный пароль' });
        
        user.lastSeen = new Date().toISOString();
        writeJSON(USERS_FILE, users);
        res.json({ ok: true, user: { ...user, passwordHash: undefined } });
    } catch (err) { res.status(500).json({ ok: false, error: 'Ошибка' }); }
});

app.post('/api/profile/update', async (req, res) => {
    const { userId, name, nickname, bio, phone, hidePhone, hideStatus, avatar } = req.body;
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

    writeJSON(USERS_FILE, users);
    res.json({ ok: true, user: { ...me, passwordHash: undefined } });
});

app.post('/api/users/ban', (req, res) => {
    const { userId, targetId } = req.body;
    const users = readJSON(USERS_FILE, []);
    const me = users.find(u => u.id === userId);
    if (!me) return res.json({ ok: false });
    
    if (!me.banned) me.banned = [];
    const idx = me.banned.indexOf(targetId);
    if (idx > -1) me.banned.splice(idx, 1);
    else me.banned.push(targetId);
    
    writeJSON(USERS_FILE, users);
    res.json({ ok: true, banned: me.banned.includes(targetId) });
});

app.get('/api/users/search', (req, res) => {
    const q = (req.query.q || '').toLowerCase();
    const users = readJSON(USERS_FILE, []);
    const found = users.filter(u => u.id !== req.query.myId && !u.banned?.includes(req.query.myId) && (u.nickname.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)));
    res.json({ ok: true, users: found.map(u => ({ ...u, passwordHash: undefined })) });
});

app.get('/api/friends', (req, res) => {
    const users = readJSON(USERS_FILE, []);
    const me = users.find(u => u.id === req.query.userId);
    if (!me) return res.json({ ok: false });
    const friends = users.filter(u => me.friends.includes(u.id)).map(u => ({ ...u, passwordHash: undefined }));
    res.json({ ok: true, friends });
});

app.post('/api/friends/add', (req, res) => {
    const { userId, friendId } = req.body;
    const users = readJSON(USERS_FILE, []);
    const me = users.find(u => u.id === userId);
    const friend = users.find(u => u.id === friendId);
    if (!me || !friend) return res.json({ ok: false });
    if (!me.friends.includes(friendId)) me.friends.push(friendId);
    if (!friend.friends.includes(userId)) friend.friends.push(userId);
    writeJSON(USERS_FILE, users);
    res.json({ ok: true });
});

app.post('/api/friends/remove', (req, res) => {
    const { userId, friendId } = req.body;
    const users = readJSON(USERS_FILE, []);
    const me = users.find(u => u.id === userId);
    const friend = users.find(u => u.id === friendId);
    if (!me || !friend) return res.json({ ok: false });
    me.friends = me.friends.filter(id => id !== friendId);
    friend.friends = friend.friends.filter(id => id !== userId);
    writeJSON(USERS_FILE, users);
    res.json({ ok: true });
});

app.get('/api/messages', (req, res) => {
    const { user1, user2 } = req.query;
    const messages = readJSON(MESSAGES_FILE, []);
    const users = readJSON(USERS_FILE, []);
    const me = users.find(u => u.id === user1);
    const other = users.find(u => u.id === user2);
    
    if (me.banned?.includes(user2) || other.banned?.includes(user1)) return res.json({ ok: false, error: 'Бан' });

    const dialog = messages.filter(m => (m.from === user1 && m.to === user2) || (m.from === user2 && m.to === user1));
    res.json({ ok: true, messages: dialog });
});

// УДАЛЕНИЕ СООБЩЕНИЙ
app.post('/api/messages/delete', (req, res) => {
    const { messageId, userId } = req.body;
    let messages = readJSON(MESSAGES_FILE, []);
    
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return res.json({ ok: false });
    if (msg.from !== userId) return res.json({ ok: false });

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

        if (data.type === 'message') {
            const { from, to, text, image } = data;
            const messages = readJSON(MESSAGES_FILE, []);
            const msg = { id: Date.now().toString(), from, to, text: text || '', image: image || null, createdAt: new Date().toISOString(), status: 'sent' };
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