const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
const port = 3001;

// Lấy từ Stringee Dashboard
const STRINGEE_PROJECT_ID = 'Y2426200';
const STRINGEE_KEY_SID = 'SK.0.XOn3lmnKxqivxBa6BdkarOXhqsfXwXTN';
const STRINGEE_KEY_SECRET = 'dVZ5RGE3ejZnNFRpVjNibDFHNUxBTG05aThvb0dk';

app.get('/stringee-token', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600; // Token sống 1 tiếng

  const payload = {
    jti: `${STRINGEE_KEY_SID}-${Date.now()}`,   
    iss: STRINGEE_KEY_SID,
    exp,
    userId,
    rest_api: true
  };

  const token = jwt.sign(payload, STRINGEE_KEY_SECRET, { algorithm: 'HS256', header: { cty: 'stringee-api;v=1', typ: 'JWT' } });
  res.json({ accessToken: token });
});

app.listen(port, () => {
  console.log(`Stringee token server listening at http://localhost:${port}`);
});
