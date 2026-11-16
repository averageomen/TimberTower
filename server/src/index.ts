import cors from 'cors';
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import { RoomManager } from './roomManager.js';
import { CompactBlockTuple, Quat, Vec3 } from './types.js';

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? '*';

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'jenga-server', timestamp: Date.now() });
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

const roomManager = new RoomManager(
  (roomId, state) => {
    io.to(roomId).emit('room:state', state);
  },
  (roomId, message) => {
    io.to(roomId).emit('chat:system', message);
  }
);

io.on('connection', (socket) => {
  socket.on(
    'room:create',
    (
      payload: { playerName: string },
      ack?: (response: { ok: boolean; roomId?: string; error?: string }) => void
    ) => {
      try {
        const room = roomManager.createRoom(socket.id, payload?.playerName ?? 'Host');
        socket.join(room.roomId);
        socket.emit('room:state', room);
        ack?.({ ok: true, roomId: room.roomId });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create room.';
        socket.emit('room:error', { message });
        ack?.({ ok: false, error: message });
      }
    }
  );

  socket.on(
    'room:join',
    (
      payload: { roomId: string; playerName: string },
      ack?: (response: { ok: boolean; roomId?: string; error?: string }) => void
    ) => {
      const result = roomManager.joinRoom(
        socket.id,
        payload?.roomId ?? '',
        payload?.playerName ?? 'Player'
      );

      if (!result.ok) {
        socket.emit('room:error', { message: result.error });
        ack?.({ ok: false, error: result.error });
        return;
      }

      socket.join(result.room.roomId);
      io.to(result.room.roomId).emit('room:state', result.room);

      const joinedPlayer = result.room.players.find((p) => p.id === socket.id);
      io.to(result.room.roomId).emit('chat:system', {
        id: `${Date.now()}-${socket.id}`,
        senderId: 'system',
        senderName: 'Jenga Referee',
        message: result.reconnected
          ? `${joinedPlayer?.name ?? 'A player'} reconnected!`
          : `${joinedPlayer?.name ?? 'A player'} joined the table.`,
        emoji: result.reconnected ? '🔌' : '🪵',
        system: true,
        timestamp: Date.now(),
      });

      ack?.({ ok: true, roomId: result.room.roomId });
    }
  );

  socket.on('game:start', (payload: { roomId: string }) => {
    const result = roomManager.startGame(socket.id, payload?.roomId ?? '');
    if (!result.ok) {
      socket.emit('room:error', { message: result.error });
      return;
    }

    io.to(result.room.roomId).emit('room:state', result.room);
    io.to(result.room.roomId).emit('chat:system', {
      id: `${Date.now()}-start`,
      senderId: 'system',
      senderName: 'Jenga Referee',
      message: 'Match started! Pull any block below the top layer.',
      emoji: '🎯',
      system: true,
      timestamp: Date.now(),
    });
  });

  socket.on('block:hover', (payload: { roomId: string; blockId: number | null }) => {
    if (!payload?.roomId) return;
    if (!roomManager.canHover(socket.id, payload.roomId)) return;
    socket.to(payload.roomId.toUpperCase()).emit('block:hovered', {
      blockId: payload.blockId,
      playerId: socket.id,
    });
  });

  socket.on(
    'block:grab',
    (payload: { roomId: string; blockId: number; committed?: boolean }) => {
      if (!payload?.roomId || typeof payload.blockId !== 'number') return;
      const result = roomManager.grabBlock(
        socket.id,
        payload.roomId,
        payload.blockId,
        Boolean(payload.committed)
      );

      if (!result.ok) {
        socket.emit('room:error', { message: result.error });
        return;
      }

      socket.to(result.room.roomId).emit('block:grabbed', {
        blockId: payload.blockId,
        playerId: socket.id,
        committed: Boolean(payload.committed),
      });

      if (result.lockedNow) {
        io.to(result.room.roomId).emit('room:state', result.room);
      }
    }
  );

  socket.on(
    'physics:sync',
    (payload: { roomId: string; blocks: CompactBlockTuple[] }) => {
      if (!payload?.roomId || !Array.isArray(payload.blocks)) return;
      const accepted = roomManager.syncPhysics(
        socket.id,
        payload.roomId,
        payload.blocks
      );
      if (!accepted) return;

      socket.to(payload.roomId.toUpperCase()).emit('physics:state', payload.blocks);
    }
  );

  socket.on(
    'block:placed',
    (payload: {
      roomId: string;
      blockId: number;
      finalTransform: { position: Vec3; quaternion: Quat };
      targetLayer?: number;
      targetSlot?: number;
    }) => {
      if (!payload?.roomId || typeof payload.blockId !== 'number' || !payload.finalTransform) {
        return;
      }

      const result = roomManager.placeBlock(
        socket.id,
        payload.roomId,
        payload.blockId,
        payload.finalTransform,
        payload.targetLayer,
        payload.targetSlot
      );

      if (!result.ok) {
        socket.emit('room:error', { message: result.error });
        return;
      }

      io.to(result.room.roomId).emit('room:state', result.room);
    }
  );

  socket.on('game:collapse', (payload: { roomId: string; loserId?: string }) => {
    if (!payload?.roomId) return;
    const result = roomManager.reportCollapse(payload.roomId, payload.loserId);
    if (!result.ok) return;
    io.to(result.room.roomId).emit('room:state', result.room);
  });

  socket.on('game:rematch', (payload: { roomId: string }) => {
    if (!payload?.roomId) return;
    const result = roomManager.rematch(socket.id, payload.roomId);
    if (!result.ok) {
      socket.emit('room:error', { message: result.error });
      return;
    }
    io.to(result.room.roomId).emit('room:state', result.room);
  });

  socket.on(
    'chat:send',
    (payload: { roomId: string; message?: string; emoji?: string }) => {
      if (!payload?.roomId) return;
      const chat = roomManager.buildPlayerChatMessage(
        socket.id,
        payload.roomId,
        payload.message ?? '',
        payload.emoji
      );
      if (!chat) return;
      io.to(payload.roomId.toUpperCase()).emit('chat:message', chat);
    }
  );

  socket.on('disconnect', () => {
    roomManager.handleDisconnect(socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Jenga authoritative server listening on http://localhost:${PORT}`);
});
