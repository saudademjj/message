import { useMemo } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { ApiClient } from './api';
import { AuthProvider } from './contexts/AuthContext';
import { CryptoProvider } from './contexts/CryptoContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { ChatRoutePage } from './pages/ChatRoutePage';
import { LoginRoutePage } from './pages/LoginRoutePage';
import './App.css';

const API_BASE =
  import.meta.env.VITE_API_BASE ?? window.location.origin;

function App() {
  const api = useMemo(() => new ApiClient(API_BASE), []);

  const LoginRouteView = () => (
    <LoginRoutePage />
  );

  const ChatRouteView = () => {
    const { roomId } = useParams<{ roomId?: string }>();
    const numericRoomID = roomId && /^\d+$/.test(roomId) ? Number(roomId) : null;
    return (
      <ChatRoutePage api={api} routeMode="chat" roomIDFromRoute={numericRoomID} />
    );
  };

  const AdminRouteView = () => (
    <ChatRoutePage api={api} routeMode="admin" roomIDFromRoute={null} />
  );

  return (
    <AuthProvider api={api}>
      <CryptoProvider>
        <WebSocketProvider apiBase={API_BASE}>
          <Routes>
            <Route path="/login" element={<LoginRouteView />} />
            <Route path="/chat" element={<ChatRouteView />} />
            <Route path="/chat/:roomId" element={<ChatRouteView />} />
            <Route path="/admin" element={<AdminRouteView />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </WebSocketProvider>
      </CryptoProvider>
    </AuthProvider>
  );
}

export default App;
