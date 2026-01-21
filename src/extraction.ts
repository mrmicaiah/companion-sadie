// ============================================================
// EXTRACTION SYSTEM — Background Memory Processing
// Sadie Hartley | Fun/Play Domain
// Runs after conversation ends to update memory
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import {
  CoreMemory,
  RelationshipMemory,
  PersonMemory,
  ConversationSummary,
  ThreadsFile,
  Thread,
  loadCore,
  saveCore,
  loadRelationship,
  saveRelationship,
  loadPerson,
  savePerson,
  listPeople,
  loadThreads,
  saveThreads,
  appendConversation
} from './memory';

// ============================================================
// EXTRACTION PROMPTS
// ============================================================

const FACT_EXTRACTION_PROMPT = `You are extracting facts from a conversation for memory storage.

CURRENT USER PROFILE:
{core}

CONVERSATION:
{transcript}

Extract any NEW facts about the user. Only include things explicitly stated or strongly implied. Do not assume or infer beyond what's said.

Return JSON only:
{
  "updates": {
    "name": "if mentioned and different from current",
    "age": number or null,
    "location": "if mentioned",
    "job": { "title": "", "field": "", "feelings": "" },
    "relationship_status": "if mentioned",
    "living_situation": "if mentioned",
    "new_interests": ["newly mentioned interests"],
    "new_struggles": ["newly mentioned challenges"],
    "new_joys": ["things that made them happy"],
    "new_goals": ["aspirations mentioned"],
    "new_quirks": ["personality traits shown"],
    "communication_style": "if clear pattern emerges"
  }
}

Only include fields with actual new information. If nothing new: { "updates": {} }`;

const RELATIONSHIP_EXTRACTION_PROMPT = `You are updating the relationship profile between Sadie and this user.

CURRENT RELATIONSHIP STATE:
{relationship}

CONVERSATION:
{transcript}

Look for:
- Trust signals (opening up, vulnerability, asking personal questions)
- Inside jokes forming or being referenced
- Patterns in when/how they reach out
- Meaningful moments worth remembering
- Phase indicators (are they becoming closer, drifting, etc.)

Return JSON only:
{
  "phase_change": "new" | "building" | "close" | "drifting" | null,
  "vibe_update": "updated vibe description or null",
  "new_trust_indicators": ["moments of vulnerability or trust"],
  "new_inside_jokes": [{ "reference": "short label", "context": "what it means" }],
  "new_patterns": ["patterns noticed"],
  "new_highlights": [{ "moment": "what happened", "significance": "low|medium|high" }]
}

If nothing notable: { "phase_change": null, "vibe_update": null, "new_trust_indicators": [], "new_inside_jokes": [], "new_patterns": [], "new_highlights": [] }`;

const PEOPLE_EXTRACTION_PROMPT = `You are extracting information about people mentioned in a conversation.

KNOWN PEOPLE (slugs):
{known_people}

CONVERSATION:
{transcript}

For each person mentioned:
- Are they new or already known?
- What's their relationship to the user?
- What was said about them?
- How does the user feel about them?

Create slugs in format: "name-relationship" (e.g., "mike-boss", "sarah-friend", "mom")

Return JSON only:
{
  "people": [
    {
      "name": "the name used",
      "slug": "lowercase-slug",
      "is_new": true | false,
      "relationship_to_user": "boss, mom, friend, ex, coworker, etc",
      "sentiment": "positive" | "negative" | "neutral" | "mixed",
      "facts_learned": ["facts from this conversation"],
      "context": "one line about what was said"
    }
  ]
}

If no people mentioned: { "people": [] }`;

const SUMMARY_EXTRACTION_PROMPT = `You are creating a conversation summary for long-term memory storage.

CONVERSATION:
{transcript}

Create a summary that captures what matters. Another AI will read this months later to remember what happened.

Return JSON only:
{
  "should_store": true | false,
  "summary": {
    "summary": "2-3 sentence summary of what happened",
    "people_mentioned": ["slugs of people mentioned"],
    "topics": ["relevant topic tags like: burnout, work, relationships, joy, creativity"],
    "emotional_tone": "primary emotional tone",
    "vibe": "playful | deep | heavy | casual | venting | celebrating",
    "notable": "what makes this worth remembering, or null",
    "message_count": number
  }
}

Guidelines:
- should_store = false for trivial exchanges ("hey" "hey" "nm" "same")
- should_store = true for anything with substance
- Be concise but capture the essence
- Include emotional context — how did they seem?`;

const THREAD_EXTRACTION_PROMPT = `You are detecting follow-up opportunities from a conversation.

CURRENT ACTIVE THREADS:
{threads}

CONVERSATION:
{transcript}

Look for things worth following up on:
- Events happening soon ("interview Thursday", "party this weekend")
- Decisions pending ("thinking about quitting", "might try X")
- Situations unresolved ("waiting to hear back")
- Emotional states to check on ("been really stressed about...")

Return JSON only:
{
  "new_threads": [
    {
      "topic": "short description",
      "follow_up_after": "YYYY-MM-DD",
      "prompt": "what Sadie should ask about"
    }
  ],
  "resolved_threads": ["topics that are now resolved"],
  "updated_threads": [
    {
      "topic": "existing topic",
      "new_date": "YYYY-MM-DD",
      "reason": "why date changed"
    }
  ]
}

If nothing to track: { "new_threads": [], "resolved_threads": [], "updated_threads": [] }`;

// ============================================================
// EXTRACTION RUNNER
// ============================================================

interface ExtractionResult {
  factsUpdated: boolean;
  relationshipUpdated: boolean;
  peopleUpdated: string[];
  summaryStored: boolean;
  threadsUpdated: boolean;
}

export async function runExtractions(
  bucket: R2Bucket,
  anthropic: Anthropic,
  chatId: string,
  transcript: string,
  messageCount: number
): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    factsUpdated: false,
    relationshipUpdated: false,
    peopleUpdated: [],
    summaryStored: false,
    threadsUpdated: false
  };

  // Skip for very short conversations
  if (messageCount < 4) {
    return result;
  }

  try {
    // Load current memory state
    const [core, relationship, knownPeople, threads] = await Promise.all([
      loadCore(bucket, chatId),
      loadRelationship(bucket, chatId),
      listPeople(bucket, chatId),
      loadThreads(bucket, chatId)
    ]);

    // Run all extraction prompts in parallel
    const [factResult, relationshipResult, peopleResult, summaryResult, threadResult] = await Promise.all([
      extractFacts(anthropic, core, transcript),
      extractRelationship(anthropic, relationship, transcript),
      extractPeople(anthropic, knownPeople, transcript),
      extractSummary(anthropic, transcript, messageCount),
      extractThreads(anthropic, threads, transcript)
    ]);

    // Apply fact updates
    if (factResult?.updates && Object.keys(factResult.updates).length > 0) {
      const updates = factResult.updates;
      if (updates.name) core.name = updates.name;
      if (updates.age) core.age = updates.age;
      if (updates.location) core.location = updates.location;
      if (updates.job) {
        if (updates.job.title) core.job.title = updates.job.title;
        if (updates.job.field) core.job.field = updates.job.field;
        if (updates.job.feelings) core.job.feelings = updates.job.feelings;
      }
      if (updates.relationship_status) core.relationship_status = updates.relationship_status;
      if (updates.living_situation) core.living_situation = updates.living_situation;
      if (updates.new_interests?.length) core.interests.push(...updates.new_interests);
      if (updates.new_struggles?.length) core.struggles.push(...updates.new_struggles);
      if (updates.new_joys?.length) core.joys.push(...updates.new_joys);
      if (updates.new_goals?.length) core.goals.push(...updates.new_goals);
      if (updates.new_quirks?.length) core.quirks.push(...updates.new_quirks);
      if (updates.communication_style) core.communication_style = updates.communication_style;
      
      await saveCore(bucket, chatId, core);
      result.factsUpdated = true;
    }

    // Apply relationship updates
    if (relationshipResult) {
      let changed = false;
      if (relationshipResult.phase_change) {
        relationship.phase = relationshipResult.phase_change;
        changed = true;
      }
      if (relationshipResult.vibe_update) {
        relationship.vibe = relationshipResult.vibe_update;
        changed = true;
      }
      if (relationshipResult.new_trust_indicators?.length) {
        relationship.trust_indicators.push(...relationshipResult.new_trust_indicators);
        changed = true;
      }
      if (relationshipResult.new_inside_jokes?.length) {
        const now = new Date().toISOString();
        for (const joke of relationshipResult.new_inside_jokes) {
          relationship.inside_jokes.push({
            reference: joke.reference,
            context: joke.context,
            created: now
          });
        }
        changed = true;
      }
      if (relationshipResult.new_patterns?.length) {
        relationship.patterns_noticed.push(...relationshipResult.new_patterns);
        changed = true;
      }
      if (relationshipResult.new_highlights?.length) {
        const now = new Date().toISOString().split('T')[0];
        for (const h of relationshipResult.new_highlights) {
          relationship.highlights.push({
            moment: h.moment,
            date: now,
            significance: h.significance
          });
        }
        changed = true;
      }
      
      if (changed) {
        await saveRelationship(bucket, chatId, relationship);
        result.relationshipUpdated = true;
      }
    }

    // Apply people updates
    if (peopleResult?.people?.length) {
      const now = new Date().toISOString();
      for (const p of peopleResult.people) {
        const existing = await loadPerson(bucket, chatId, p.slug);
        
        if (existing) {
          // Update existing person
          existing.key_facts.push(...p.facts_learned);
          existing.notable_conversations.push({
            date: now.split('T')[0],
            summary: p.context
          });
          existing.last_mentioned = now;
          existing.mention_count++;
          if (p.sentiment !== 'neutral') {
            existing.sentiment = p.sentiment;
          }
          await savePerson(bucket, chatId, existing);
        } else {
          // Create new person
          const newPerson: PersonMemory = {
            name: p.name,
            slug: p.slug,
            relationship_to_user: p.relationship_to_user,
            sentiment: p.sentiment,
            key_facts: p.facts_learned,
            notable_conversations: [{
              date: now.split('T')[0],
              summary: p.context
            }],
            first_mentioned: now,
            last_mentioned: now,
            mention_count: 1
          };
          await savePerson(bucket, chatId, newPerson);
        }
        result.peopleUpdated.push(p.slug);
      }
    }

    // Store conversation summary
    if (summaryResult?.should_store && summaryResult.summary) {
      const now = new Date();
      const summary: ConversationSummary = {
        id: `${chatId}_${Date.now()}`,
        date: now.toISOString().split('T')[0],
        time: now.toTimeString().split(' ')[0],
        summary: summaryResult.summary.summary,
        people_mentioned: summaryResult.summary.people_mentioned || [],
        topics: summaryResult.summary.topics || [],
        emotional_tone: summaryResult.summary.emotional_tone,
        vibe: summaryResult.summary.vibe,
        notable: summaryResult.summary.notable,
        message_count: messageCount
      };
      await appendConversation(bucket, chatId, summary);
      result.summaryStored = true;
    }

    // Apply thread updates
    if (threadResult) {
      let changed = false;
      
      // Add new threads
      if (threadResult.new_threads?.length) {
        for (const t of threadResult.new_threads) {
          threads.active_threads.push({
            topic: t.topic,
            created: new Date().toISOString(),
            follow_up_after: t.follow_up_after,
            prompt: t.prompt,
            resolved: false
          });
        }
        changed = true;
      }
      
      // Mark resolved threads
      if (threadResult.resolved_threads?.length) {
        for (const topic of threadResult.resolved_threads) {
          const thread = threads.active_threads.find(t => t.topic === topic);
          if (thread) thread.resolved = true;
        }
        changed = true;
      }
      
      // Update thread dates
      if (threadResult.updated_threads?.length) {
        for (const u of threadResult.updated_threads) {
          const thread = threads.active_threads.find(t => t.topic === u.topic);
          if (thread) thread.follow_up_after = u.new_date;
        }
        changed = true;
      }
      
      if (changed) {
        // Clean up old resolved threads
        threads.active_threads = threads.active_threads.filter(t => !t.resolved);
        await saveThreads(bucket, chatId, threads);
        result.threadsUpdated = true;
      }
    }

  } catch (error) {
    console.error('Extraction error:', error);
  }

  return result;
}

// ============================================================
// INDIVIDUAL EXTRACTION FUNCTIONS
// ============================================================

async function extractFacts(
  anthropic: Anthropic,
  core: CoreMemory,
  transcript: string
): Promise<{ updates: any } | null> {
  try {
    const prompt = FACT_EXTRACTION_PROMPT
      .replace('{core}', JSON.stringify(core, null, 2))
      .replace('{transcript}', transcript);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-3-5-20241022',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content.find(b => b.type === 'text')?.text;
    if (text) {
      return JSON.parse(text);
    }
  } catch (e) {
    console.error('Fact extraction error:', e);
  }
  return null;
}

async function extractRelationship(
  anthropic: Anthropic,
  relationship: RelationshipMemory,
  transcript: string
): Promise<any | null> {
  try {
    const prompt = RELATIONSHIP_EXTRACTION_PROMPT
      .replace('{relationship}', JSON.stringify(relationship, null, 2))
      .replace('{transcript}', transcript);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-3-5-20241022',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content.find(b => b.type === 'text')?.text;
    if (text) {
      return JSON.parse(text);
    }
  } catch (e) {
    console.error('Relationship extraction error:', e);
  }
  return null;
}

async function extractPeople(
  anthropic: Anthropic,
  knownPeople: string[],
  transcript: string
): Promise<{ people: any[] } | null> {
  try {
    const prompt = PEOPLE_EXTRACTION_PROMPT
      .replace('{known_people}', knownPeople.join(', ') || 'none yet')
      .replace('{transcript}', transcript);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-3-5-20241022',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content.find(b => b.type === 'text')?.text;
    if (text) {
      return JSON.parse(text);
    }
  } catch (e) {
    console.error('People extraction error:', e);
  }
  return null;
}

async function extractSummary(
  anthropic: Anthropic,
  transcript: string,
  messageCount: number
): Promise<{ should_store: boolean; summary: any } | null> {
  try {
    const prompt = SUMMARY_EXTRACTION_PROMPT
      .replace('{transcript}', transcript)
      .replace('number', String(messageCount));

    const response = await anthropic.messages.create({
      model: 'claude-haiku-3-5-20241022',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content.find(b => b.type === 'text')?.text;
    if (text) {
      return JSON.parse(text);
    }
  } catch (e) {
    console.error('Summary extraction error:', e);
  }
  return null;
}

async function extractThreads(
  anthropic: Anthropic,
  threads: ThreadsFile,
  transcript: string
): Promise<any | null> {
  try {
    const activeThreads = threads.active_threads
      .filter(t => !t.resolved)
      .map(t => `- ${t.topic} (follow up after ${t.follow_up_after})`)
      .join('\n') || 'none';

    const prompt = THREAD_EXTRACTION_PROMPT
      .replace('{threads}', activeThreads)
      .replace('{transcript}', transcript);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-3-5-20241022',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content.find(b => b.type === 'text')?.text;
    if (text) {
      return JSON.parse(text);
    }
  } catch (e) {
    console.error('Thread extraction error:', e);
  }
  return null;
}
