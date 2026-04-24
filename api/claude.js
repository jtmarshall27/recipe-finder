const Anthropic = require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.CLAUDE_API_KEY) {
    return res.status(500).json({ error: 'CLAUDE_API_KEY environment variable is not set. Add it in your Vercel project settings.' });
  }

  const { messages, system } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

  try {
    const params = {
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages,
    };

    if (system) {
      // Use prompt caching for the system prompt (kicks in at ≥1024 tokens on Sonnet)
      params.system = [
        {
          type: 'text',
          text: system,
          cache_control: { type: 'ephemeral' },
        },
      ];
    }

    const response = await client.messages.create(params);
    return res.status(200).json({ content: response.content[0].text });
  } catch (err) {
    console.error('Claude API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
