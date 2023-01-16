const DEBUG = false;

const cmp = new Intl.Collator('en').compare;

const inf = Infinity;

const OPTS = {
	// term segmentation & punct/whitespace merging
	interSplit: '[^A-Za-z0-9]+',
	intraSplit: '[a-z][A-Z]',

	// intra bounds that will be used to increase lft1/rgt1 info counters
	intraBound: '[A-Za-z][0-9]|[0-9][A-Za-z]|[a-z][A-Z]',

	// inter-bounds mode
	// 2 = strict (will only match 'man' on whitepace and punct boundaries: Mega Man, Mega_Man, mega.man)
	// 1 = loose  (plus allowance for alpha-num and case-change boundaries: MegaMan, 0007man)
	// 0 = any    (will match 'man' as any substring: megamaniac)
	interLft: 0,
	interRgt: 0,

	// allowance between terms
	interChars: '.',
	interIns: inf,

	// allowance between chars in terms
	intraChars: '[a-z\\d]', // internally case-insensitive
	intraIns: 0,

	// multi-insert or single-error mode
	intraMode: 0,

	// single-error bounds for errors within terms, default requires exact first char
	intraSlice: [1, inf],

	// single-error tolerance toggles
	intraSub: 0,
	intraTrn: 0,
	intraDel: 0,

	// can post-filter matches that are too far apart in distance or length
	// (since intraIns is between each char, it can accum to nonsense matches)
	intraFilt: (term, match, index) => true, // should this also accept WIP info?

	// final sorting fn
	sort: (info, haystack, needle) => {
		let {
			idx,
			chars,
			terms,
			interLft2,
			interLft1,
		//	interRgt2,
		//	interRgt1,
			start,
			intraIns,
			interIns,
		} = info;

		return idx.map((v, i) => i).sort((ia, ib) => (
			// most contig chars matched
			chars[ib] - chars[ia] ||
			// least char intra-fuzz (most contiguous)
			intraIns[ia] - intraIns[ib] ||
			// most prefix bounds, boosted by full term matches
			(
				(terms[ib] + interLft2[ib] + 0.5 * interLft1[ib]) -
				(terms[ia] + interLft2[ia] + 0.5 * interLft1[ia])
			) ||
			// highest density of match (least span)
		//	span[ia] - span[ib] ||
			// highest density of match (least term inter-fuzz)
			interIns[ia] - interIns[ib] ||
			// earliest start of match
			start[ia] - start[ib] ||
			// alphabetic
			cmp(haystack[idx[ia]], haystack[idx[ib]])
		));
	},
};

const lazyRepeat = (chars, limit) => (
	limit == 0   ? ''           :
	limit == 1   ? chars + '??' :
	limit == inf ? chars + '*?' :
	               chars + `{0,${limit}}?`
);

const mode2Tpl = '(?:\\b|_)';

export default function uFuzzy(opts) {
	opts = Object.assign({}, OPTS, opts);

	const {
		interLft,
		interRgt,
		intraMode,
		intraSlice,
		intraIns,
		intraSub,
		intraTrn,
		intraDel,
		intraSplit: _intraSplit,
		interSplit: _interSplit,
		intraBound: _intraBound,
		intraChars,
	} = opts;

	let { intraRules } = opts;

	if (intraRules == null) {
		intraRules = p => {
			// default is exact term matches only
			let _intraSlice = OPTS.intraSlice, // requires first char
				_intraIns = 0,
				_intraSub = 0,
				_intraTrn = 0,
				_intraDel = 0;

			let plen = p.length;

			// prevent junk matches by requiring stricter rules for short terms
			if (plen <= 4) {
				if (plen >= 3) {
					// one swap in non-first char when 3-4 chars
					_intraTrn = Math.min(intraTrn, 1);

					// or one insertion when 4 chars
					if (plen == 4)
						_intraIns = Math.min(intraIns, 1);
				}
				// else exact match when 1-2 chars
			}
			// use supplied opts
			else {
				_intraSlice = intraSlice;
				_intraIns = intraIns,
				_intraSub = intraSub,
				_intraTrn = intraTrn,
				_intraDel = intraDel;
			}

			return {
				intraSlice: _intraSlice,
				intraIns: _intraIns,
				intraSub: _intraSub,
				intraTrn: _intraTrn,
				intraDel: _intraDel,
			};
		};
	}

	let withIntraSplit = !!_intraSplit;

	let intraSplit = new RegExp(_intraSplit, 'g');
	let interSplit = new RegExp(_interSplit, 'g');

	let trimRe = new RegExp('^' + _interSplit + '|' + _interSplit + '$', 'g');

	const split = needle => {
		needle = needle.replace(trimRe, '');

		if (withIntraSplit)
			needle = needle.replace(intraSplit, m => m[0] + ' ' + m[1]);

		return needle.split(interSplit);
	};

	const prepQuery = (needle, capt = 0) => {
		// split on punct, whitespace, num-alpha, and upper-lower boundaries
		let parts = split(needle);

		// array of regexp tpls for each term
		let reTpl;

		// allows single mutations within each term
		if (intraMode == 1) {
			reTpl = parts.map(p => {
				let {
					intraSlice,
					intraIns,
					intraSub,
					intraTrn,
					intraDel,
				} = intraRules(p);

				if (intraIns + intraSub + intraTrn + intraDel == 0)
					return p;

				let [lftIdx, rgtIdx] = intraSlice;
				let lftChar = p.slice(0, lftIdx);
				let rgtChar = p.slice(rgtIdx);

				let chars = p.slice(lftIdx, rgtIdx);

				let numChars = chars.length;

				let variants = [];

				// variants with single char substitutions
				if (intraSub) {
					for (let i = 0; i < numChars; i++)
						variants.push(lftChar + chars.slice(0, i) + intraChars + chars.slice(i + 1) + rgtChar);
				}

				// variants with single transpositions
				if (intraTrn) {
					for (let i = 0; i < numChars - 1; i++) {
						if (chars[i] != chars[i+1])
							variants.push(lftChar + chars.slice(0, i) + chars[i+1] + chars[i] + chars.slice(i + 2) + rgtChar);
					}
				}

				// variants with single char omissions
				if (intraDel) {
					for (let i = 0; i < numChars; i++)
						variants.push(lftChar + chars.slice(0, i + 1) + '?' + chars.slice(i + 1) + rgtChar);
				}

				// variants with single char insertions
				if (intraIns) {
					let intraInsTpl = lazyRepeat(intraChars, 1);

					for (let i = 0; i < numChars + 1; i++)
						variants.push(lftChar + chars.slice(0, i) + intraInsTpl + chars.slice(i) + rgtChar);
				}

				return '(?:' + p + '|' + variants.join('|') + ')';
			});
		}
		else {
			let intraInsTpl = lazyRepeat(intraChars, intraIns);

			// capture at char level
			if (capt == 2 && intraIns > 0) {
				// sadly, we also have to capture the inter-term junk via parenth-wrapping .*?
				// to accum other capture groups' indices for \b boosting during scoring
				intraInsTpl = ')(' + intraInsTpl + ')(';
			}

			reTpl = parts.map(p => p.split('').join(intraInsTpl));
		}

	//	console.log(reTpl);

		// this only helps to reduce initial matches early when they can be detected
		// TODO: might want a mode 3 that excludes _
		let preTpl = interLft == 2 ? mode2Tpl : '';
		let sufTpl = interRgt == 2 ? mode2Tpl : '';

		let interCharsTpl = sufTpl + lazyRepeat(opts.interChars, opts.interIns) + preTpl;

		// capture at word level
		if (capt > 0) {
			// sadly, we also have to capture the inter-term junk via parenth-wrapping .*?
			// to accum other capture groups' indices for \b boosting during scoring
			reTpl = '(' + reTpl.join(')(' + interCharsTpl + ')(') + ')';
		}
		else
			reTpl = reTpl.join(interCharsTpl);

		if (capt > 0) {
			if (interLft == 2)
				reTpl = '(' + preTpl + ')' + reTpl + '(' + sufTpl + ')';
			else
				reTpl = '(.?)' + reTpl + '(.?)';
		}
		else
			reTpl = preTpl + reTpl + sufTpl;

	//	console.log(reTpl);

		return [new RegExp(reTpl, 'i'), parts];
	};

	const filter = (haystack, needle, idxs) => {
		DEBUG && console.time('filter');

		let out = [];
		let [query] = prepQuery(needle);

		if (idxs != null) {
			for (let i = 0; i < idxs.length; i++) {
				let idx = idxs[i];
				query.test(haystack[idx]) && out.push(idx);
			}
		}
		else {
			for (let i = 0; i < haystack.length; i++)
				query.test(haystack[i]) && out.push(i);
		}

		DEBUG && console.timeEnd('filter');

		return out;
	};

	let withIntraBound = !!_intraBound;

	let interBound = new RegExp(_interSplit);
	let intraBound = new RegExp(_intraBound);

	const info = (idxs, haystack, needle) => {
		DEBUG && console.time('info');

		let [query, parts] = prepQuery(needle, 1);
		let [queryR] = prepQuery(needle, 2);

		let len = idxs.length;

		let field = Array(len).fill(0);

		let info = {
			// idx in haystack
			idx: Array(len),

			// start of match
			start: field.slice(),
			// length of match
		//	span: field.slice(),

			// contiguous chars matched
			chars: field.slice(),

			// contiguous (no fuzz) and bounded terms (intra=0, lft2/1, rgt2/1)
			// excludes terms that are contiguous but have < 2 bounds (substrings)
			terms: field.slice(),

			// cumulative length of unmatched chars (fuzz) within span
			interIns: field.slice(), // between terms
			intraIns: field.slice(), // within terms

			// interLft/interRgt counters
			interLft2: field.slice(),
			interRgt2: field.slice(),
			interLft1: field.slice(),
			interRgt1: field.slice(),

			ranges: Array(len),
		};

		// might discard idxs based on bounds checks
		let mayDiscard = interLft == 1 || interRgt == 1;

		let ii = 0;

		for (let i = 0; i < idxs.length; i++) {
			let mhstr = haystack[idxs[i]];
			let m = mhstr.match(query);

			// leading junk
			let start = m.index + m[1].length;

			let idxAcc = start;
		//	let span = m[0].length;

			let disc = false;
			let lft2 = 0;
			let lft1 = 0;
			let rgt2 = 0;
			let rgt1 = 0;
			let chars = 0;
			let terms = 0;
			let inter = 0;
			let intra = 0;

			for (let j = 0, k = 2; j < parts.length; j++, k+=2) {
				let group = m[k].toLowerCase();
				let fullMatch = group == parts[j];

				if (!fullMatch) {
					// when intraIns > 0 'test' query can match 'ttest' in 'fittest'
					// try an exact substring match to improve rank quality
					if (intraIns > 0) {
						let idxOf = group.indexOf(parts[j]);
						if (idxOf > -1) {
							fullMatch = true;
							idxAcc += idxOf;
							m[k] = m[k].slice(idxOf);

							if (j == 0) {
								start = idxAcc;
							//	span -= idxOf;
							}
						}
					}

					// TODO: use difference in group/part length to boost eSyms? or iSyms (inexact)
				}

				if (mayDiscard || fullMatch) {
					// does group's left and/or right land on \b
					let lftCharIdx = idxAcc - 1;
					let rgtCharIdx = idxAcc + m[k].length;

					let isPre = true;
					let isSuf = true;

					// prefix info
					if (lftCharIdx == -1           || interBound.test(mhstr[lftCharIdx]))
						fullMatch && lft2++;
					else {
						if (interLft == 2) {
							disc = true;
							break;
						}

						if (withIntraBound && intraBound.test(mhstr[lftCharIdx] + mhstr[lftCharIdx + 1]))
							fullMatch && lft1++;
						else {
							if (interLft == 1) {
								disc = true;
								break;
							}

							isPre = false;
						}
					}

					// suffix info
					if (rgtCharIdx == mhstr.length || interBound.test(mhstr[rgtCharIdx]))
						fullMatch && rgt2++;
					else {
						if (interRgt == 2) {
							disc = true;
							break;
						}

						if (withIntraBound && intraBound.test(mhstr[rgtCharIdx - 1] + mhstr[rgtCharIdx]))
							fullMatch && rgt1++;
						else {
							if (interRgt == 1) {
								disc = true;
								break;
							}

							isSuf = false;
						}
					}

					if (fullMatch) {
						chars += parts[j].length;

						if (isPre && isSuf)
							terms++;
					}
				}
				else
					intra += group.length - parts[j].length; // intraFuzz

				if (j > 0)
					inter += m[k-1].length; // interFuzz

				if (!opts.intraFilt(parts[j], group, idxAcc)) {
					disc = true;
					break;
				}

				if (j < parts.length - 1)
					idxAcc += m[k].length + m[k+1].length;
			}

			if (!disc) {
				info.idx[ii]       = idxs[i];
				info.interLft2[ii] = lft2;
				info.interLft1[ii] = lft1;
				info.interRgt2[ii] = rgt2;
				info.interRgt1[ii] = rgt1;
				info.chars[ii]     = chars;
				info.terms[ii]     = terms;
				info.interIns[ii]  = inter;
				info.intraIns[ii]  = intra;

				info.start[ii] = start;
			//	info.span[ii] = span;

				// ranges
				let m = mhstr.match(queryR);
				let ranges = info.ranges[ii] = [];

				let idxAcc = m.index + m[1].length;
				let from = idxAcc;
				let to = idxAcc;
				for (let i = 2; i < m.length; i++) {
					let len = m[i].length;

					idxAcc += len;

					if (i % 2 == 0)
						to = idxAcc;
					else if (len > 0) {
						ranges.push(from, to);
						from = to = idxAcc;
					}
				}

				if (to > from)
					ranges.push(from, to);

				ii++;
			}
		}

		// trim arrays
		if (ii < idxs.length) {
			for (let k in info)
				info[k] = info[k].slice(0, ii);
		}

		DEBUG && console.timeEnd('info');

		return info;
	};

	// returns [idxs, info, order]
	const _search = (haystack, needle, outOfOrder = false, infoThresh = 1e3, preFiltered) => {
		let needles = null;
		let matches = null;

		if (outOfOrder) {
			// since uFuzzy is an AND-based search, we can iteratively pre-reduce the haystack by searching
			// for each term in isolation before running permutations on what's left.
			// this is a major perf win. e.g. searching "test man ger pp a" goes from 570ms -> 14ms
			let terms = split(needle);

			if (terms.length > 1) {
				// longest -> shortest
				let terms2 = terms.slice().sort((a, b) => b.length - a.length);

				for (let ti = 0; ti < terms2.length; ti++) {
					// no haystack item contained all terms
					if (preFiltered?.length == 0)
						return [[], null, null];

					preFiltered = filter(haystack, terms2[ti], preFiltered);
				}

				needles = permute(terms).map(perm => perm.join(' '));

				// filtered matches for each needle excluding same matches for prior needles
				matches = [];

				// keeps track of already-matched idxs to skip in follow-up permutations
				let matchedIdxs = new Set();

				for (let ni = 0; ni < needles.length; ni++) {
					if (matchedIdxs.size < preFiltered.length) {
						// filter further for this needle, exclude already-matched
						let preFiltered2 = preFiltered.filter(idx => !matchedIdxs.has(idx));

						let matched = filter(haystack, needles[ni], preFiltered2);

						for (let j = 0; j < matched.length; j++)
							matchedIdxs.add(matched[j]);

						matches.push(matched);
					}
					else
						matches.push([]);
				}
			}
		}

		// non-ooo or ooo w/single term
		if (needles == null) {
			needles = [needle];
			matches = [preFiltered?.length > 0 ? preFiltered : filter(haystack, needle)];
		}

		let matchCount = matches.reduce((acc, idxs) => acc + idxs.length, 0);

		let retInfo = null;
		let retOrder = null;

		// rank, sort, concat
		if (matchCount <= infoThresh) {
			retInfo = {};
			retOrder = [];

			for (let ni = 0; ni < matches.length; ni++) {
				let idxs = matches[ni];

				if (idxs == null || idxs.length == 0)
					continue;

				let needle = needles[ni];
				let _info = info(idxs, haystack, needle);
				let order = opts.sort(_info, haystack, needle);

				// offset idxs for concat'ing infos
				if (ni > 0) {
					for (let i = 0; i < order.length; i++)
						order[i] += retOrder.length;
				}

				for (let k in _info)
					retInfo[k] = (retInfo[k] ?? []).concat(_info[k]);

				retOrder = retOrder.concat(order);
			}
		}

		return [
			[].concat(...matches),
			retInfo,
			retOrder,
		];
	};

	return {
		search: (...args) => {
			DEBUG && console.time('search');
			let out = _search(...args);
			DEBUG && console.timeEnd('search');
			return out;
		},
		split,
		filter,
		info,
		sort: opts.sort,
	};
}

const latinize = (() => {
	let accents = {
		A: 'ÁÀÃÂÄĄ',
		a: 'áàãâäą',
		E: 'ÉÈÊËĖ',
		e: 'éèêëę',
		I: 'ÍÌÎÏĮ',
		i: 'íìîïį',
		O: 'ÓÒÔÕÖ',
		o: 'óòôõö',
		U: 'ÚÙÛÜŪŲ',
		u: 'úùûüūų',
		C: 'ÇČ',
		c: 'çč',
		N: 'Ñ',
		n: 'ñ',
		S: 'Š',
		s: 'š'
	};

	let accentsMap = new Map();
	let accentsTpl = '';

	for (let r in accents) {
		accents[r].split('').forEach(a => {
			accentsTpl += a;
			accentsMap.set(a, r);
		});
	}

	let accentsRe = new RegExp(`[${accentsTpl}]`, 'g');

	return strings => {
		let out = Array(strings.length);
		for (let i = 0; i < strings.length; i++)
			out[i] = strings[i].replace(accentsRe, m => accentsMap.get(m));
		return out;
	};
})();

// https://stackoverflow.com/questions/9960908/permutations-in-javascript/37580979#37580979
function permute(arr) {
	arr = arr.slice();

	let length = arr.length,
		result = [arr.slice()],
		c = new Array(length).fill(0),
		i = 1, k, p;

	while (i < length) {
		if (c[i] < i) {
			k = i % 2 && c[i];
			p = arr[i];
			arr[i] = arr[k];
			arr[k] = p;
			++c[i];
			i = 1;
			result.push(arr.slice());
		} else {
			c[i] = 0;
			++i;
		}
	}

	return result;
}

const _mark = (part, matched) => matched ? `<mark>${part}</mark>` : part;
const _append = (acc, part) => acc + part;

function highlight(str, ranges, mark = _mark, accum = '', append = _append) {
	accum = append(accum, mark(str.substring(0, ranges[0]), false)) ?? accum;

	for (let i = 0; i < ranges.length; i+=2) {
		let fr = ranges[i];
		let to = ranges[i+1];

		accum = append(accum, mark(str.substring(fr, to), true)) ?? accum;

		if (i < ranges.length - 3)
			accum = append(accum, mark(str.substring(ranges[i+1], ranges[i+2]), false)) ?? accum;
	}

	accum = append(accum, mark(str.substring(ranges[ranges.length - 1]), false)) ?? accum;

	return accum;
}

uFuzzy.latinize = latinize;
uFuzzy.permute = arr => {
	let idxs = permute([...Array(arr.length).keys()]).sort((a,b) => {
		for (let i = 0; i < a.length; i++) {
			if (a[i] != b[i])
				return a[i] - b[i];
		}
		return 0;
	});

	return idxs.map(pi => pi.map(i => arr[i]));
};
uFuzzy.highlight = highlight;