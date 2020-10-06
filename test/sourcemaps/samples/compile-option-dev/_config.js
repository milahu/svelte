import MagicString from 'magic-string';

// TODO move util fns to test index.js

function result(filename, src, options = {}) {
	// default: generateDecodedMap
	const map_fn = options.encodeMappings ? src.generateMap : src.generateDecodedMap;
	delete options.encodeMappings;

	return {
		code: src.toString(),
		map: map_fn.apply(src, [{
			source: filename,
			hires: true,
			includeContent: false,
			...options
		}])
	};
}

function replace_all(src, search, replace) {
	let idx = src.original.indexOf(search);
	if (idx == -1) throw new Error('search not found in src');
	do {
		src.overwrite(idx, idx + search.length, replace);
	} while ((idx = src.original.indexOf(search, idx + 1)) != -1);
}

export default {
	compile_options: {
		dev: true
	},
	preprocess: [
		{ style: ({ content, filename }) =>  {
				const src = new MagicString(content);
				replace_all(src, '--replace-me-once', '\n --done-replace-once');
				replace_all(src, '--replace-me-twice', '\n--almost-done-replace-twice');
				return result(filename, src);
		} },
		{ style: ({ content, filename }) =>  {
				const src = new MagicString(content);
				replace_all(src, '--almost-done-replace-twice', '\n  --done-replace-twice');
				return result(filename, src);
		} }
	]
};
