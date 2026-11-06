import React from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';
import App from './App.js';

const html = htm.bind(React.createElement);

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(html`<${App} />`);
}