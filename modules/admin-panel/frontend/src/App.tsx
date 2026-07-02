import { Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from './components/Layout';
import { XiaoniActivityPage } from './pages/XiaoniActivityPage';
import { XiaoniPassiveRecallPage } from './pages/XiaoniPassiveRecallPage';
import { XiaoniRecoveryPage } from './pages/XiaoniRecoveryPage';
import { XiaoniRuntimeSettingsPage } from './pages/XiaoniRuntimeSettingsPage';
import { GroupManagementPage } from './pages/GroupManagementPage';
import { PrivateChatManagementPage } from './pages/PrivateChatManagementPage';
import { PromptManagementPage } from './pages/PromptManagementPage';
import { PromptDetailPage } from './pages/PromptDetailPage';
import { PromptEditPage } from './pages/PromptEditPage';
import QueueManagementPage from './pages/QueueManagementPage';
import { HttpTrafficMonitorPage } from './pages/HttpTrafficMonitorPage';
import { HttpTrafficDetailPage } from './pages/HttpTrafficDetailPage';
import { ProviderRequestDesignPreviewPage } from './pages/ProviderRequestDesignPreviewPage';
import { PlaygroundPage } from './pages/PlaygroundPage';
import { ImageLabPage } from './pages/ImageLabPage';
import './globals.css';
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const PromptRedirect: React.FC = () => {
  const { promptId } = useParams<{ promptId: string }>();
  return <Navigate to={`/prompts/${promptId}/detail`} replace />;
};

const PromptDebugRedirect: React.FC = () => {
  const { promptId } = useParams<{ promptId: string }>();
  return <Navigate to={`/playground?promptId=${promptId}`} replace />;
};

function RouteFallback() {
  return (
    <div className="flex min-h-[calc(100vh-12rem)] items-center justify-center px-6">
      <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
        Loading page...
      </div>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <Layout>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Navigate to="/xiaoni-action-stream" replace />} />
              <Route path="/xiaoni-action-stream" element={<XiaoniActivityPage />} />
              <Route path="/xiaoni-passive-recall" element={<XiaoniPassiveRecallPage />} />
              <Route path="/xiaoni-recovery" element={<XiaoniRecoveryPage />} />
              <Route path="/xiaoni-runtime-settings" element={<XiaoniRuntimeSettingsPage />} />
              <Route path="/xiaoni-activity" element={<Navigate to="/xiaoni-action-stream" replace />} />
              <Route path="/dashboard" element={<Navigate to="/xiaoni-action-stream" replace />} />
              <Route path="/xiaoni/action-stream/events/:eventId/trace" element={<Navigate to="/xiaoni-action-stream" replace />} />
              <Route path="/groups" element={<GroupManagementPage />} />
              <Route path="/groups/:groupId" element={<Navigate to="/groups" replace />} />
              <Route path="/private-chats" element={<PrivateChatManagementPage />} />
              <Route path="/private-chats/:userId" element={<Navigate to="/private-chats" replace />} />
              <Route path="/prompts" element={<PromptManagementPage />} />
              <Route path="/prompts/new" element={<PromptEditPage />} />
              <Route path="/prompts/:promptId" element={<PromptRedirect />} />
              <Route path="/prompts/:promptId/detail" element={<PromptDetailPage />} />
              <Route path="/prompts/:promptId/edit" element={<PromptEditPage />} />
              <Route path="/prompts/:promptId/debug" element={<PromptDebugRedirect />} />
              <Route path="/queue-management" element={<QueueManagementPage />} />
              <Route path="/traffic" element={<HttpTrafficMonitorPage />} />
              <Route path="/traffic/:id" element={<HttpTrafficDetailPage />} />
              <Route path="/design/provider-request-preview" element={<ProviderRequestDesignPreviewPage />} />
              <Route path="/playground" element={<PlaygroundPage />} />
              <Route path="/image-lab" element={<ImageLabPage />} />
            </Routes>
          </Suspense>
        </Layout>
      </Router>
    </QueryClientProvider>
  );
}

export default App;
