import React from 'react';
import { html } from './Icons.js';

export default function LegalView({ metaLeft, metaRight, clauses }) {
  return html`
    <div className="legal-doc-wrapper">
      <div className="legal-meta-banner">
        <span>${metaLeft}</span>
        <span>${metaRight}</span>
      </div>

      ${clauses.map(clause => html`
        <div key=${clause.title} className="legal-clause-card">
          <h3>${clause.title}</h3>
          <p>${clause.body}</p>
        </div>
      `)}
    </div>
  `;
}