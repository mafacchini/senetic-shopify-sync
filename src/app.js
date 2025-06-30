const express = require('express');
const app = express();
const path = require('path');
const routes = require('./routes/routes');

const PORT = process.env.PORT || 3000;

app.use('/', routes);

app.listen(PORT, () => console.log(`App in ascolto sulla porta ${PORT}`));