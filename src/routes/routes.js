const express = require('express');
const router = express.Router();
const Controller = require('../controllers/controller');
const controller = new Controller();

router.get('/senetic-inventory', controller.showSeneticInventory.bind(controller));
router.get('/senetic-catalogue', controller.showSeneticCatalogue.bind(controller));
router.get('/import-shopify', controller.importToShopify.bind(controller));

module.exports = router;