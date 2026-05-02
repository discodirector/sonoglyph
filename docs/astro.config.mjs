// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Sonoglyph documentation site.
//
// Served at https://docs.sonoglyph.xyz (subdomain handled by Caddy on the
// Hetzner VPS — see deploy/Caddyfile). The build output lives in
// docs/dist/ and is served as a static directory; no runtime needed.
//
// Sidebar order matches the natural reading order for someone landing on
// the site: what is this → how does a descent work → the moving parts
// (audio engine, agent, Kimi, chain) → how to run it locally.

// https://astro.build/config
export default defineConfig({
	site: 'https://docs.sonoglyph.xyz',
	integrations: [
		starlight({
			title: 'Sonoglyph',
			description:
				'Descend with Hermes. Carve a sonoglyph. Mint it on Monad.',
			// Dark first — matches the aesthetic of the live experience
			// (sonoglyph.xyz is near-black with muted greys). Starlight's
			// "auto" still lets users flip to light mode.
			customCss: ['./src/styles/custom.css'],
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/discodirector/sonoglyph',
				},
				{
					icon: 'external',
					label: 'Live site',
					href: 'https://sonoglyph.xyz',
				},
			],
			editLink: {
				baseUrl:
					'https://github.com/discodirector/sonoglyph/edit/main/docs/',
			},
			lastUpdated: true,
			sidebar: [
				{
					label: 'Overview',
					items: [
						{ label: 'What is Sonoglyph', slug: 'overview/what' },
						{ label: 'How a descent works', slug: 'overview/descent' },
						{ label: 'Architecture', slug: 'overview/architecture' },
					],
				},
				{
					label: 'Composition',
					items: [
						{
							label: 'Per-session randomization',
							slug: 'composition/randomization',
						},
						{ label: 'Layers & pads', slug: 'composition/layers' },
					],
				},
				{
					label: 'The agent',
					items: [
						{ label: 'MCP tool surface', slug: 'agent/mcp' },
						{ label: 'How Hermes decides', slug: 'agent/decisions' },
					],
				},
				{
					label: 'Artifacts',
					items: [
						{ label: 'Journal generation', slug: 'artifacts/journal' },
						{ label: 'Glyph generation', slug: 'artifacts/glyph' },
					],
				},
				{
					label: 'Chain',
					items: [
						{ label: 'On-chain storage', slug: 'chain/storage' },
						{ label: 'Mint flow', slug: 'chain/mint' },
					],
				},
				{
					label: 'Run it',
					items: [
						{ label: 'Run locally', slug: 'run/local' },
						{ label: 'Deploy', slug: 'run/deploy' },
					],
				},
			],
		}),
	],
});
