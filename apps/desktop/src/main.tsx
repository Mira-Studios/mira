import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';
import { getBrowserSettings } from './features/settings/browserSettings';
import { applyTheme } from './features/themes/applyTheme';
import { getThemeById } from './features/themes/themeLoader';
import { applyLayout } from './features/layouts/applyLayout';
import { getLayoutById } from './features/layouts/layoutLoader';

// Establish geometry and fonts before any tab/header elements are measured or painted.
const initialSettings = getBrowserSettings();
applyTheme(getThemeById(initialSettings.themeId));
applyLayout(getLayoutById(initialSettings.layoutId));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
