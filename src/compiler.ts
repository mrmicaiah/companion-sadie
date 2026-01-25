// ============================================================
// CHARACTER MIND COMPILER
// Integrates into Cloudflare Worker for admin API
// ============================================================

interface CompileResult {
  success: boolean;
  character: string;
  compiled: CompiledCharacter | null;
  errors: string[];
  warnings: string[];
  stats: {
    filesLoaded: number;
    peopleLoaded: number;
    totalSize: number;
    compiledSize?: number;
  };
}

export interface CompiledCharacter {
  $schema: string;
  $version: string;
  $compiled_at: string;
  $character: string;
  $source_hash: string;
  identity: any;
  voice: any;
  values: any;
  boundaries: any;
  axes: {
    activities: Record<string, any>;
    urgency: Record<string, any>;
    moods: Record<string, any>;
    time_weights: Record<string, any>;
    special_events: any[];
  };
  detection: {
    topics: Record<string, any>;
    emotions: Record<string, any>;
    flows: Record<string, any>;
    investment: any;
  };
  library: {
    books: any[];
    podcasts: any[];
    places: any[];
    stories: any[];
    advice: any[];
    opinions: any[];
  };
  people: {
    index: any[];
    details: Record<string, any>;
  };
}

const SOURCE_STRUCTURE: Record<string, string> = {
  identity: 'character/identity.json',
  voice: 'character/voice.json',
  values: 'character/values.json',
  boundaries: 'character/boundaries.json',
  'axes.activities': 'character/axes/activities.json',
  'axes.urgency': 'character/axes/urgency.json',
  'axes.moods': 'character/axes/moods.json',
  'axes.time_weights': 'character/axes/time-weights.json',
  'axes.special_events': 'character/axes/special-events.json',
  'detection.topics': 'character/detection/topics.json',
  'detection.emotions': 'character/detection/emotions.json',
  'detection.flows': 'character/detection/flows.json',
  'detection.investment': 'character/detection/investment.json',
  'library.books': 'character/library/books.json',
  'library.podcasts': 'character/library/podcasts.json',
  'library.places': 'character/library/places.json',
  'library.stories': 'character/library/stories.json',
  'library.advice': 'character/library/advice.json',
  'library.opinions': 'character/library/opinions.json',
  'people.index': 'character/people/_index.json',
};

// ============================================================
// COMPILE FUNCTION
// ============================================================

export async function compileCharacter(bucket: R2Bucket, character: string): Promise<CompileResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats = {
    filesLoaded: 0,
    peopleLoaded: 0,
    totalSize: 0,
    compiledSize: 0,
  };

  const sourceData: Record<string, any> = {};

  // Load all source files
  for (const [key, path] of Object.entries(SOURCE_STRUCTURE)) {
    try {
      const obj = await bucket.get(path);
      if (obj) {
        const text = await obj.text();
        sourceData[key] = JSON.parse(text);
        stats.filesLoaded++;
        stats.totalSize += text.length;
      } else {
        warnings.push(`Missing file: ${path}`);
      }
    } catch (e) {
      errors.push(`Error loading ${path}: ${(e as Error).message}`);
    }
  }

  // Load individual people files
  const peopleDetails: Record<string, any> = {};
  if (sourceData['people.index']?.people) {
    for (const person of sourceData['people.index'].people) {
      const personPath = `character/people/${person.slug}.json`;
      try {
        const obj = await bucket.get(personPath);
        if (obj) {
          const text = await obj.text();
          peopleDetails[person.slug] = JSON.parse(text);
          stats.peopleLoaded++;
          stats.totalSize += text.length;
        } else {
          warnings.push(`Missing person file: ${personPath}`);
        }
      } catch (e) {
        errors.push(`Error loading ${personPath}: ${(e as Error).message}`);
      }
    }
  }

  // Check critical files
  const criticalFiles = ['identity', 'voice', 'values', 'boundaries'];
  const missingCritical = criticalFiles.filter(f => !sourceData[f]);
  if (missingCritical.length > 0) {
    errors.push(`Missing critical files: ${missingCritical.join(', ')}`);
    return { success: false, character, compiled: null, errors, warnings, stats };
  }

  // Assemble compiled structure
  const compiled: CompiledCharacter = {
    $schema: 'character-compiled',
    $version: '2.0',
    $compiled_at: new Date().toISOString(),
    $character: character,
    $source_hash: '',

    identity: sourceData.identity || {},
    voice: sourceData.voice || {},
    values: sourceData.values || {},
    boundaries: sourceData.boundaries || {},

    axes: {
      activities: sourceData['axes.activities']?.activity_types || {},
      urgency: sourceData['axes.urgency']?.levels || {},
      moods: sourceData['axes.moods']?.moods || {},
      time_weights: sourceData['axes.time_weights']?.time_periods || {},
      special_events: sourceData['axes.special_events']?.recurring_events || [],
    },

    detection: {
      topics: sourceData['detection.topics']?.topics || {},
      emotions: sourceData['detection.emotions']?.emotions || {},
      flows: sourceData['detection.flows']?.flows || {},
      investment: sourceData['detection.investment'] || {},
    },

    library: {
      books: sourceData['library.books']?.books || [],
      podcasts: sourceData['library.podcasts']?.podcasts || [],
      places: sourceData['library.places']?.places || [],
      stories: sourceData['library.stories']?.stories || [],
      advice: sourceData['library.advice']?.advice || [],
      opinions: sourceData['library.opinions']?.opinions || [],
    },

    people: {
      index: sourceData['people.index']?.people || [],
      details: peopleDetails,
    },
  };

  // Generate hash
  compiled.$source_hash = generateHash(JSON.stringify(compiled));

  // Calculate size
  const compiledJson = JSON.stringify(compiled);
  stats.compiledSize = compiledJson.length;

  // Validate
  const validation = validateCompiled(compiled);
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);

  return {
    success: errors.length === 0,
    character,
    compiled: errors.length === 0 ? compiled : null,
    errors,
    warnings,
    stats,
  };
}

// ============================================================
// VALIDATION
// ============================================================

function validateCompiled(compiled: CompiledCharacter): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check identity
  if (!compiled.identity?.name?.goes_by) {
    errors.push('Missing identity.name.goes_by');
  }

  // Check voice
  if (!compiled.voice?.never_says || compiled.voice.never_says.length === 0) {
    warnings.push('No never_says defined in voice');
  }

  // Check topics
  const topicCount = Object.keys(compiled.detection?.topics || {}).length;
  if (topicCount === 0) {
    errors.push('No topics defined');
  }

  // Check library
  if ((compiled.library?.books?.length || 0) === 0) {
    warnings.push('No books in library');
  }
  if ((compiled.library?.stories?.length || 0) === 0) {
    warnings.push('No stories in library');
  }

  // Check story/book references
  const storyIds = new Set(compiled.library.stories.map((s: any) => s.id));
  const bookIds = new Set(compiled.library.books.map((b: any) => b.id));

  for (const [topicKey, topic] of Object.entries(compiled.detection.topics)) {
    const guidance = (topic as any).guidance || {};
    for (const storyRef of guidance.stories || []) {
      if (!storyIds.has(storyRef)) {
        warnings.push(`Topic '${topicKey}' references missing story: ${storyRef}`);
      }
    }
    for (const bookRef of guidance.books || []) {
      if (!bookIds.has(bookRef)) {
        warnings.push(`Topic '${topicKey}' references missing book: ${bookRef}`);
      }
    }
  }

  return { errors, warnings };
}

function generateHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// ============================================================
// RUNTIME LOADER WITH CACHING
// ============================================================

let characterCache: { data: CompiledCharacter; timestamp: number; hash: string } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function loadCharacter(bucket: R2Bucket): Promise<CompiledCharacter> {
  const now = Date.now();

  // Check cache
  if (characterCache && (now - characterCache.timestamp) < CACHE_TTL) {
    return characterCache.data;
  }

  // Load from R2
  const obj = await bucket.get('character.json');
  if (!obj) {
    throw new Error('character.json not found - run compile first');
  }

  const data = await obj.json() as CompiledCharacter;

  // Update cache
  characterCache = {
    data,
    timestamp: now,
    hash: data.$source_hash,
  };

  return data;
}

export function invalidateCharacterCache(): void {
  characterCache = null;
}

// ============================================================
// ADMIN API HANDLERS
// ============================================================

export async function handleCompileEndpoint(bucket: R2Bucket, character: string): Promise<Response> {
  const result = await compileCharacter(bucket, character);

  if (result.success && result.compiled) {
    // Upload compiled file
    await bucket.put('character.json', JSON.stringify(result.compiled, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });

    // Invalidate cache
    invalidateCharacterCache();
  }

  return new Response(JSON.stringify({
    success: result.success,
    errors: result.errors,
    warnings: result.warnings,
    stats: result.stats,
    compiled_at: result.compiled?.$compiled_at,
    hash: result.compiled?.$source_hash,
  }, null, 2), {
    status: result.success ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleSourceList(bucket: R2Bucket): Promise<Response> {
  const files: string[] = [];
  
  // List all files in character/
  const listed = await bucket.list({ prefix: 'character/' });
  for (const obj of listed.objects) {
    files.push(obj.key);
  }

  return new Response(JSON.stringify({ files }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleSourceRead(bucket: R2Bucket, path: string): Promise<Response> {
  const obj = await bucket.get(path);
  if (!obj) {
    return new Response('Not found', { status: 404 });
  }

  const content = await obj.text();
  return new Response(content, {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleSourceWrite(bucket: R2Bucket, path: string, content: string): Promise<Response> {
  // Validate JSON
  try {
    JSON.parse(content);
  } catch (e) {
    return new Response(`Invalid JSON: ${(e as Error).message}`, { status: 400 });
  }

  // Validate path is in character/
  if (!path.startsWith('character/')) {
    return new Response('Can only write to character/ directory', { status: 400 });
  }

  await bucket.put(path, content, {
    httpMetadata: { contentType: 'application/json' },
  });

  return new Response(JSON.stringify({ success: true, path }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleSourceDelete(bucket: R2Bucket, path: string): Promise<Response> {
  // Validate path
  if (!path.startsWith('character/')) {
    return new Response('Can only delete from character/ directory', { status: 400 });
  }

  // Don't allow deleting critical files
  const criticalFiles = [
    'character/identity.json',
    'character/voice.json',
    'character/values.json',
    'character/boundaries.json',
  ];
  if (criticalFiles.includes(path)) {
    return new Response('Cannot delete critical file', { status: 400 });
  }

  await bucket.delete(path);

  return new Response(JSON.stringify({ success: true, deleted: path }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
