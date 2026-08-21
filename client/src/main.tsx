import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppWithBoundary } from './App';
import { I18nProvider } from './i18n/I18nProvider';
import { ToastProvider } from './components/ToastProvider';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <AppWithBoundary />
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
