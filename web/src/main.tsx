import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BotGallery } from './components/BotGallery';
import { MarkdownGallery } from './components/MarkdownGallery';
import './styles.css';

const gallery = new URLSearchParams(window.location.search).get('gallery');
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      {gallery === 'bots' ? <BotGallery /> : gallery === 'md' ? <MarkdownGallery /> : <App />}
    </StrictMode>,
  );
}
