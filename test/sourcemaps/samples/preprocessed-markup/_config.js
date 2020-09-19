import MagicString from 'magic-string';

export default {
	preprocess: {
		markup: ({ content, filename }) =>  {
			const src = new MagicString(content);
			const idx = content.indexOf("baritone");
			src.overwrite(idx, idx+"baritone".length, "bar");
			return {
				code: src.toString(),
				map: src.generateMap({
					source: filename,
					includeContent: false
				})
			};
		}
	}
};
