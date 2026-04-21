#!/usr/bin/env node

const { execFileSync } = require('child_process');
const path = require('path');

const target = process.argv[2];

if (!target) {
	console.error('Usage: node scripts/inspect-was.js <path-to-.was>');
	process.exit(1);
}

const run = (args) =>
	execFileSync('unzip', args, {
		encoding: 'utf8',
		maxBuffer: 20 * 1024 * 1024,
	});

const safeJsonParse = (text) => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

const summarizeAnimation = (name, animation) => {
	if (!animation || typeof animation !== 'object' || Array.isArray(animation)) {
		console.log(`\n${name}`);
		console.log('  not valid JSON object');
		return;
	}

	const layers = Array.isArray(animation.layers) ? animation.layers : [];
	const assets = Array.isArray(animation.assets) ? animation.assets : [];
	const markers = Array.isArray(animation.markers) ? animation.markers : [];
	const metadata = animation.metadata || {};
	const customProps = metadata.customProps || {};

	console.log(`\n${name}`);
	console.log(`  name: ${animation.nm || 'unknown'}`);
	console.log(`  version: ${animation.v || 'unknown'}`);
	console.log(`  size: ${animation.w || '?'}x${animation.h || '?'}`);
	console.log(`  frames: ${animation.ip || 0} -> ${animation.op || 0} @ ${animation.fr || '?'} fps`);
	console.log(`  layers: ${layers.length}`);
	console.log(`  assets: ${assets.length}`);
	console.log(`  markers: ${markers.length}`);

	const animatedTransformLayers = layers.filter(layer => {
		const ks = layer.ks || {};
		return ['p', 'r', 's', 'a', 'sk', 'sa', 'o'].some(
			key => ks[key] && ks[key].a === 1
		);
	});

	console.log(`  animated transform layers: ${animatedTransformLayers.length}`);
	if (animatedTransformLayers.length) {
		console.log(
			`  sample animated layers: ${animatedTransformLayers
				.slice(0, 8)
				.map(layer => layer.nm || `layer-${layer.ind}`)
				.join(', ')}`
		);
	}

	if (Object.keys(customProps).length) {
		console.log(`  customProps: ${JSON.stringify(customProps)}`);
	}
};

const normalizedTarget = path.resolve(target);

console.log(`Inspecting ${normalizedTarget}`);

const entries = run(['-Z1', normalizedTarget])
	.split('\n')
	.map(line => line.trim())
	.filter(Boolean);

console.log('\nEntries:');
for (const entry of entries) {
	console.log(`  ${entry}`);
}

const jsonEntries = entries.filter(entry => entry.endsWith('.json'));

for (const entry of jsonEntries) {
	const text = run(['-p', normalizedTarget, entry]);
	const json = safeJsonParse(text);
	summarizeAnimation(entry, json);
}
