import { SourceMapConsumer } from 'source-map';

// browser vs node.js
const b64dec = typeof atob == 'function' ? atob : s => Buffer.from(s, 'base64').toString();

export async function test({ assert, input, css, preprocessed, js }) {

	const match = js.code.match(/\tstyle\.textContent = "(.*?)(?:\\n\/\*# sourceMappingURL=data:(.*?);charset=(.*?);base64,(.*?) \*\/)?";\n/);
	assert.notEqual(match, null);

	const [_, cssText, mimeType, encoding, cssMapBase64] = match;
	assert.equal(mimeType, 'application/json');
	assert.equal(encoding, 'utf-8');

	const cssMapJson = b64dec(cssMapBase64);
	css.mapConsumer = await new SourceMapConsumer(cssMapJson);

	// TODO make util fn + move to test index.js
	const sourcefile = 'input.svelte';
	[
		// TODO how to get line + column numbers?
		[css, '--keep-me', 13, 2],
		[css, '--done-replace-once', 6, 5],
		[css, '--done-replace-twice', 9, 5]
	]
	.forEach(([where, content, line, column]) => {
		assert.deepEqual(
			where.mapConsumer.originalPositionFor(
				where.locate_1(content)
			),
			{
				source: sourcefile,
				name: null,
				line,
				column
			},
			`failed to locate "${content}" from "${sourcefile}"`
		);
	});
}
