// server/server.js — сервер мессенджера с WebSocket и группами

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const http = require('http');
const { WebSocketServer } = require('ws');
const { readJSON, writeJSON, USERS_FILE, MESSAGES_FILE, GROUPS_FILE } = require('./db');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ==================== HTTP API ====================

// ---------- РЕГИСТРАЦИЯ ----------
app.post('/api/register', async (req, res) => {
    try {
        const { name, nickname, email, password, passwordConfirm } = req.body;

        if (!name || !nickname || !email || !password || !passwordConfirm) {
            return res.status(400).json({ ok: false, error: 'Заполните все поля' });
        }
        if (password !== passwordConfirm) {
            return res.status(400).json({ ok: false, error: 'Пароли не совпадают' });
        }
        if (password.length < 6) {
            return res.status(400).json({ ok: false, error: 'Пароль минимум 6 символов' });
        }

        const users = readJSON(USERS_FILE, []);

        if (users.find(u => u.nickname.toLowerCase() === nickname.toLowerCase())) {
            return res.status(400).json({ ok: false, error: 'Этот ник уже занят' });
        }
        if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
            return res.status(400).json({ ok: false, error: 'Эта почта уже зарегистрирована' });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const newUser = {
            id: Date.now().toString(),
            name: name.trim(),
            nickname: nickname.trim(),
            email: email.trim().toLowerCase(),
            passwordHash,
            friends: [],
            createdAt: new Date().toISOString()
        };

        users.push(newUser);
        writeJSON(USERS_FILE, users);

        console.log(`✅ Новый пользователь: ${newUser.nickname}`);
        res.json({ ok: true, message: 'Регистрация успешна!', userId: newUser.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// ---------- ВХОД ----------
app.post('/api/login', async (req, res) => {
    try {
        const { login, password } = req.body;
        if (!login || !password) {
            return res.status(400).json({ ok: false, error: 'Введите логин и пароль' });
        }

        const users = readJSON(USERS_FILE, []);
        const user = users.find(u =>
            u.nickname.toLowerCase() === login.toLowerCase() ||
            u.email.toLowerCase() === login.toLowerCase()
        );

        if (!user) {
            return res.status(400).json({ ok: false, error: 'Пользователь не найден' });
        }

        const passwordOk = await bcrypt.compare(password, user.passwordHash);
        if (!passwordOk) {
            return res.status(400).json({ ok: false, error: 'Неверный пароль' });
        }

        console.log(`✅ Вход: ${user.nickname}`);
        res.json({
            ok: true,
            message: 'Вход выполнен',
            user: { id: user.id, name: user.name, nickname: user.nickname, email: user.email }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// ---------- ПОИСК ПОЛЬЗОВАТЕЛЕЙ ----------
app.get('/api/users/search', (req, res) => {
    try {
        const q = (req.query.q || '').trim().toLowerCase();
        const currentUserId = req.query.currentUserId || '';

        if (!q || q.length < 2) return res.json({ ok: true, users: [] });

        const users = readJSON(USERS_FILE, []);
        const currentUser = users.find(u => u.id === currentUserId);
        const friends = currentUser ? (currentUser.friends || []) : [];

        const found = users
            .filter(u => u.id !== currentUserId)
            .filter(u => !friends.includes(u.id))
            .filter(u => u.nickname.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))
            .slice(0, 20)
            .map(u => ({ id: u.id, name: u.name, nickname: u.nickname }));

        res.json({ ok: true, users: found });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// ---------- СПИСОК ДРУЗЕЙ ----------
app.get('/api/friends', (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId) return res.status(400).json({ ok: false, error: 'Нет userId' });

        const users = readJSON(USERS_FILE, []);
        const me = users.find(u => u.id === userId);
        if (!me) return res.status(400).json({ ok: false, error: 'Пользователь не найден' });

        const friendIds = me.friends || [];
        const friends = users
            .filter(u => friendIds.includes(u.id))
            .map(u => ({ id: u.id, name: u.name, nickname: u.nickname }));

        res.json({ ok: true, friends });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// ---------- ДОБАВИТЬ В ДРУЗЬЯ ----------
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

        if (me.friends.includes(friendId)) {
            return res.status(400).json({ ok: false, error: 'Уже в друзьях' });
        }

        me.friends.push(friendId);
        friend.friends.push(userId);
        writeJSON(USERS_FILE, users);

        console.log(`✅ Дружба: ${me.nickname} ↔ ${friend.nickname}`);
        res.json({
            ok: true,
            message: `Теперь вы друзья с ${friend.nickname}`,
            friend: { id: friend.id, name: friend.name, nickname: friend.nickname }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// ---------- ИСТОРИЯ ЛИЧНЫХ СООБЩЕНИЙ ----------
app.get('/api/messages', (req, res) => {
    try {
        const { user1, user2 } = req.query;
        if (!user1 || !user2) return res.status(400).json({ ok: false, error: 'Нет user1 или user2' });

        const messages = readJSON(MESSAGES_FILE, []);
        const dialog = messages.filter(m =>
            (m.from === user1 && m.to === user2) ||
            (m.from === user2 && m.to === user1)
        );

        res.json({ ok: true, messages: dialog });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// ==================== ГРУППЫ ====================

// ---------- СОЗДАТЬ ГРУППУ ----------
app.post('/api/groups/create', (req, res) => {
    try {
        const { creatorId, name, memberIds } = req.body;
        if (!creatorId || !name || !name.trim()) {
            return res.status(400).json({ ok: false, error: 'Введите название группы' });
        }

        const users = readJSON(USERS_FILE, []);
        const creator = users.find(u => u.id === creatorId);
        if (!creator) return res.status(400).json({ ok: false, error: 'Создатель не найден' });

        const groups = readJSON(GROUPS_FILE, []);

        const members = [creatorId];
        if (Array.isArray(memberIds)) {
            memberIds.forEach(id => {
                if (id !== creatorId && users.find(u => u.id === id) && !members.includes(id)) {
                    members.push(id);
                }
            });
        }

        const group = {
            id: 'grp_' + Date.now().toString(),
            name: name.trim(),
            creatorId,
            members,
            createdAt: new Date().toISOString()
        };

        groups.push(group);
        writeJSON(GROUPS_FILE, groups);

        console.log(`✅ Группа: ${group.name} (${members.length} участников)`);

        res.json({
            ok: true,
            message: `Группа "${group.name}" создана`,
            group: { id: group.id, name: group.name, members: group.members }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// ---------- СПИСОК ГРУПП ----------
app.get('/api/groups', (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId) return res.status(400).json({ ok: false, error: 'Нет userId' });

        const groups = readJSON(GROUPS_FILE, []);
        const myGroups = groups
            .filter(g => g.members.includes(userId))
            .map(g => ({
                id: g.id,
                name: g.name,
                creatorId: g.creatorId,
                members: g.members,
                membersCount: g.members.length
            }));

        res.json({ ok: true, groups: myGroups });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// ---------- ИСТОРИЯ ГРУППОВЫХ СООБЩЕНИЙ ----------
app.get('/api/group-messages', (req, res) => {
    try {
        const { groupId } = req.query;
        if (!groupId) return res.status(400).json({ ok: false, error: 'Нет groupId' });

        const messages = readJSON(MESSAGES_FILE, []);
        const groupMsgs = messages.filter(m => m.toGroup === groupId);

        res.json({ ok: true, messages: groupMsgs });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// ---------- ПИНГ ----------
app.get('/api/ping', (req, res) => {
    res.json({ ok: true, message: 'Сервер работает!' });
});

// ==================== WebSocket ====================

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// userId → Set<WebSocket>
const clients = new Map();

wss.on('connection', (ws) => {
    let userId = null;

    ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); }
        catch { return; }

        // Аутентификация WebSocket
        if (data.type === 'auth') {
            userId = data.userId;
            if (!clients.has(userId)) clients.set(userId, new Set());
            clients.get(userId).add(ws);
            console.log(`🔌 WebSocket: подключён ${userId}`);
            return;
        }

        // ---------- ЛИЧНОЕ СООБЩЕНИЕ ----------
        if (data.type === 'message') {
            const { from, to, text } = data;
            if (!from || !to || !text || !text.trim()) return;

            const messages = readJSON(MESSAGES_FILE, []);
            const msg = {
                id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
                from,
                to,
                text: text.trim(),
                createdAt: new Date().toISOString()
            };
            messages.push(msg);
            writeJSON(MESSAGES_FILE, messages);

            const recipientSet = clients.get(to);
            if (recipientSet) {
                recipientSet.forEach(sock => {
                    if (sock.readyState === 1) {
                        sock.send(JSON.stringify({ type: 'new_message', message: msg }));
                    }
                });
            }
            ws.send(JSON.stringify({ type: 'message_sent', message: msg }));
            return;
        }

        // ---------- ГРУППОВОЕ СООБЩЕНИЕ ----------
        if (data.type === 'group_message') {
            const { from, groupId, text } = data;
            if (!from || !groupId || !text || !text.trim()) return;

            const groups = readJSON(GROUPS_FILE, []);
            const group = groups.find(g => g.id === groupId);
            if (!group) return;
            if (!group.members.includes(from)) return;

            const messages = readJSON(MESSAGES_FILE, []);
            const msg = {
                id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
                from,
                toGroup: groupId,
                text: text.trim(),
                createdAt: new Date().toISOString()
            };
            messages.push(msg);
            writeJSON(MESSAGES_FILE, messages);

            group.members.forEach(memberId => {
                if (memberId === from) return;
                const memberSet = clients.get(memberId);
                if (memberSet) {
                    memberSet.forEach(sock => {
                        if (sock.readyState === 1) {
                            sock.send(JSON.stringify({ type: 'new_group_message', message: msg }));
                        }
                    });
                }
            });

            ws.send(JSON.stringify({ type: 'group_message_sent', message: msg }));
            return;
        }
    });

    ws.on('close', () => {
        if (userId && clients.has(userId)) {
            clients.get(userId).delete(ws);
            if (clients.get(userId).size === 0) clients.delete(userId);
            console.log(`🔌 WebSocket: отключён ${userId}`);
        }
    });
});

// ==================== Запуск ====================

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен`);
    console.log(`   Локально:  http://localhost:${PORT}`);
    console.log(`   По сети:   http://<твой-IP>:${PORT}`);
    console.log(`✅ WebSocket готов`);
});