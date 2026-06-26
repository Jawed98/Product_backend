require('dotenv').config();
const express = require('express');
const path = require('path');
const productsRouter = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve the minimal bonus UI (static files) from /public
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(productsRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
