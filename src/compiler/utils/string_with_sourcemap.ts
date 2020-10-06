import { DecodedSourceMap, RawSourceMap, SourceMapLoader } from '@ampproject/remapping/dist/types/types';
import remapping from '@ampproject/remapping';
import { decode as decode_mappings, encode as encode_mappings } from 'sourcemap-codec';

type SourceLocation = {
	line: number;
	column: number;
};

function last_line_length(s: string) {
	return s.length - s.lastIndexOf('\n') - 1;
}

// mutate map in-place
export function sourcemap_add_offset(
	map: DecodedSourceMap, offset: SourceLocation
) {
	if (map.mappings.length == 0) return map;
	// shift columns in first line
	const segment_list = map.mappings[0];
	for (let segment = 0; segment < segment_list.length; segment++) {
		const seg = segment_list[segment];
		if (seg[3]) seg[3] += offset.column;
	}
	// shift lines
	for (let line = 0; line < map.mappings.length; line++) {
		const segment_list = map.mappings[line];
		for (let segment = 0; segment < segment_list.length; segment++) {
			const seg = segment_list[segment];
			if (seg[2]) seg[2] += offset.line;
		}
	}
}

function merge_tables<T>(this_table: T[], other_table): [T[], number[], boolean, boolean] {
	const new_table = this_table.slice();
	const idx_map = [];
	other_table = other_table || [];
	let val_changed = false;
	for (const [other_idx, other_val] of other_table.entries()) {
		const this_idx = this_table.indexOf(other_val);
		if (this_idx >= 0) {
			idx_map[other_idx] = this_idx;
		} else {
			const new_idx = new_table.length;
			new_table[new_idx] = other_val;
			idx_map[other_idx] = new_idx;
			val_changed = true;
		}
	}
	let idx_changed = val_changed;
	if (val_changed) {
		if (idx_map.find((val, idx) => val != idx) === undefined) {
			// idx_map is identity map [0, 1, 2, 3, 4, ....]
			idx_changed = false;
		}
	}
	return [new_table, idx_map, val_changed, idx_changed];
}

function pushArray<T>(_this: T[], other: T[]) {
	for (let i = 0; i < other.length; i++)
		_this.push(other[i]);
}

export class StringWithSourcemap {
	string: string;
	map: DecodedSourceMap;

	constructor(string = '', map = null) {
		this.string = string;
		if (map)
			this.map = map as DecodedSourceMap;
		else
			this.map = {
				version: 3,
				mappings: [],
				sources: [],
				names: []
			};
	}

	// concat in-place (mutable), return this (chainable)
	// will also mutate the `other` object
	concat(other: StringWithSourcemap): StringWithSourcemap {
		// noop: if one is empty, return the other
		if (other.string == '') return this;
		if (this.string == '') {
			this.string = other.string;
			this.map = other.map;
			return this;
		}

		this.string += other.string;

		const m1 = this.map;
		const m2 = other.map;

		if (m2.mappings.length == 0) return this;

		// combine sources and names
		const [sources, new_source_idx, sources_changed, sources_idx_changed] = merge_tables(m1.sources, m2.sources);
		const [names, new_name_idx, names_changed, names_idx_changed] = merge_tables(m1.names, m2.names);

		if (sources_changed) m1.sources = sources;
		if (names_changed) m1.names = names;

		// unswitched loops are faster
		if (sources_idx_changed && names_idx_changed) {
			for (let line = 0; line < m2.mappings.length; line++) {
				const segment_list = m2.mappings[line];
				for (let segment = 0; segment < segment_list.length; segment++) {
					const seg = segment_list[segment];
					if (seg[1]) seg[1] = new_source_idx[seg[1]];
					if (seg[4]) seg[4] = new_name_idx[seg[4]];
				}
			}
		} else if (sources_idx_changed) {
			for (let line = 0; line < m2.mappings.length; line++) {
				const segment_list = m2.mappings[line];
				for (let segment = 0; segment < segment_list.length; segment++) {
					const seg = segment_list[segment];
					if (seg[1]) seg[1] = new_source_idx[seg[1]];
				}
			}
		} else if (names_idx_changed) {
			for (let line = 0; line < m2.mappings.length; line++) {
				const segment_list = m2.mappings[line];
				for (let segment = 0; segment < segment_list.length; segment++) {
					const seg = segment_list[segment];
					if (seg[4]) seg[4] = new_name_idx[seg[4]];
				}
			}
		}

		// combine the mappings

		// combine
		// 1. last line of first map
		// 2. first line of second map
		// columns of 2 must be shifted

		const column_offset = last_line_length(this.string);
		if (m2.mappings.length > 0 && column_offset > 0) {
			// shift columns in first line
			const first_line = m2.mappings[0];
			for (let i = 0; i < first_line.length; i++) {
				first_line[i][0] += column_offset;
			}
		}

		// combine last line + first line
		pushArray(m1.mappings[m1.mappings.length - 1], m2.mappings.shift());

		// append other lines
		pushArray(m1.mappings, m2.mappings);

		return this;
	}

	static from_processed(string: string, map?: DecodedSourceMap): StringWithSourcemap {
		if (map) return new StringWithSourcemap(string, map);
		if (string == '') return new StringWithSourcemap();
		map = { version: 3, names: [], sources: [], mappings: [] };
		// add empty SourceMapSegment[] for every line
		const line_count = (string.match(/\n/g) || '').length;
		for (let i = 0; i < line_count; i++) map.mappings.push([]);
		return new StringWithSourcemap(string, map);
	}

	static from_source(
		source_file: string, source: string, offset?: SourceLocation
	): StringWithSourcemap {
		if (!offset) offset = { line: 0, column: 0 };
		const map: DecodedSourceMap = { version: 3, names: [], sources: [source_file], mappings: [] };
		if (source == '') return new StringWithSourcemap(source, map);

		// we create a high resolution identity map here,
		// we know that it will eventually be merged with svelte's map,
		// at which stage the resolution will decrease.
		const line_list = source.split('\n');
		for (let line = 0; line < line_list.length; line++) {
			map.mappings.push([]);
			const token_list = line_list[line].split(/([^\d\w\s]|\s+)/g);
			for (let token = 0, column = 0; token < token_list.length; token++) {
				if (token_list[token] == '') continue;
				map.mappings[line].push([ column, 0, offset.line + line, column ]);
				column += token_list[token].length;
			}
		}
		// shift columns in first line
		const segment_list = map.mappings[0];
		for (let segment = 0; segment < segment_list.length; segment++) {
			segment_list[segment][3] += offset.column;
		}
		return new StringWithSourcemap(source, map);
	}
}

export function combine_sourcemaps(
	filename: string,
	sourcemap_list: Array<DecodedSourceMap | RawSourceMap>,
	options?: {
		sourcemapEncodedNoWarn?: boolean,
		caller_name?: string,
		code_type?: string, // style, script, markup
		encode_mappings?: boolean
	}
): (RawSourceMap | DecodedSourceMap) {
	if (sourcemap_list.length == 0) return null;
	const last_map_idx = sourcemap_list.length - 1;

	if (options && !options.sourcemapEncodedNoWarn) {
		// show warning if preprocessors return sourcemaps with encoded mappings
		// we need decoded mappings, encode + decode is a waste of time
		const maps_encoded = [];
		for (let map_idx = last_map_idx; map_idx >= 0; map_idx--) {
			const map = sourcemap_list[map_idx];
			if (typeof map == 'string') {
				sourcemap_list[map_idx] = JSON.parse(map);
			}
			if (typeof map.mappings == 'string') {
				maps_encoded.push(last_map_idx - map_idx); // chronological index
			}
		}
		if (maps_encoded.length > 0) {
			// TODO better than console.log?
			console.log(
				'warning. '+options.caller_name+
				' received encoded '+options.code_type+' sourcemaps (index '+maps_encoded.join(', ')+'). '+
				'this is slow. make your sourcemap-generators return decoded mappings '+
				'or disable this warning with the option { sourcemapEncodedNoWarn: true }'
			);
		}
	}

	let map_idx = 1;
	const map: RawSourceMap =
		sourcemap_list.slice(0, -1)
		.find(m => m.sources.length !== 1) === undefined

			? remapping( // use array interface
					// only the oldest sourcemap can have multiple sources
					sourcemap_list,
					() => null,
					true // skip optional field `sourcesContent`
				)

			: remapping( // use loader interface
					sourcemap_list[0], // last map
					function loader(sourcefile) {
						if (sourcefile === filename && sourcemap_list[map_idx]) {
							return sourcemap_list[map_idx++]; // idx 1, 2, ...
							// bundle file = branch node
						}
						else return null; // source file = leaf node
					} as SourceMapLoader,
					true
				);

	if (options && options.encode_mappings) {
		if (typeof map.mappings == 'object')
			(map as unknown as RawSourceMap).mappings = encode_mappings((map as unknown as DecodedSourceMap).mappings);
	} else {
		// decode mappings
		// TODO remove this, when `remapping` allows to return decoded mappings, so we skip the unnecessary encode + decode steps
		// https://github.com/ampproject/remapping/pull/88
		// combine_sourcemaps should always return decoded mappings
		if (typeof map.mappings == 'string')
			(map as unknown as DecodedSourceMap).mappings = decode_mappings((map as unknown as RawSourceMap).mappings);
	}

	return map;
}

// browser vs node.js
const b64enc = typeof btoa == 'function' ? btoa : b => Buffer.from(b).toString('base64');

export function sourcemap_add_tostring_tourl(map) {
	if (!map) return;
	if (!map.toString)
		Object.defineProperty(map, 'toString', {
			enumerable: false,
			value: function toString() {
				return JSON.stringify(this);
			}
		});
	if (!map.toUrl)
		Object.defineProperty(map, 'toUrl', {
			enumerable: false,
			value: function toUrl() {
				return 'data:application/json;charset=utf-8;base64,' + b64enc(this.toString());
			}
		});
}

export function sourcemap_encode_mappings(map) {
	if (map && typeof map.mappings == 'object') {
		(map as RawSourceMap).mappings = encode_mappings(map.mappings);
	}
}

export function finalize_sourcemap(result, code_type: string, filename: string, options, caller_name = 'svelte.compile') {
	if (result.map) {
		if (options.sourcemap) {

			// TODO remove workaround
			// code-red/print should return decoded sourcemaps
			// https://github.com/Rich-Harris/code-red/pull/51
			if (typeof result.map.mappings == 'string') {
				result.map.mappings = decode_mappings(result.map.mappings);
			}

			(result.map as unknown as DecodedSourceMap) = combine_sourcemaps(
				filename,
				[
					(result.map as any), // idx 1
					options.sourcemap as DecodedSourceMap // idx 0
				],
				{
					caller_name,
					code_type,
					sourcemapEncodedNoWarn: options.sourcemapEncodedNoWarn
				}
			) as DecodedSourceMap;
		}
		// encode mappings only once, after all sourcemaps are combined
		sourcemap_encode_mappings(result.map);
		sourcemap_add_tostring_tourl(result.map);
	}
}
