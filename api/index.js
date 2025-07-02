require('dotenv').config();
const express = require('express');
const axios = require('axios');
const he = require('he');

const app = express();

const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

function extractImageUrls(htmlContent) {
  if (!htmlContent) {
    return [];
  }
  
  const decodedHtml = he.decode(htmlContent);
  const imageUrls = [];
  const imgRegex = /<img[^>]+src="([^"]+)"/gi;
  let match;
  
  while ((match = imgRegex.exec(decodedHtml)) !== null) {
    let imgUrl = match[1];
    
    if (imgUrl && 
        !imgUrl.startsWith('data:') && 
        (imgUrl.includes('.jpg') || imgUrl.includes('.jpeg') || imgUrl.includes('.png') || imgUrl.includes('.gif'))) {
      
      let fullUrl;
      if (imgUrl.startsWith('http://') || imgUrl.startsWith('https://')) {
        fullUrl = imgUrl;
      } else if (imgUrl.startsWith('//')) {
        fullUrl = `https:${imgUrl}`;
      } else if (imgUrl.startsWith('/')) {
        fullUrl = `https://senetic.pl${imgUrl}`;
      } else {
        fullUrl = `https://senetic.pl/${imgUrl}`;
      }
      
      if (!fullUrl.includes('%')) {
        try {
          const urlParts = fullUrl.split('senetic.pl');
          if (urlParts.length === 2) {
            const basePart = urlParts[0] + 'senetic.pl';
            const pathPart = urlParts[1];
            const encodedPath = pathPart.split('/').map(segment => 
              segment ? encodeURIComponent(segment) : ''
            ).join('/');
            fullUrl = basePart + encodedPath;
          }
        } catch (error) {
          console.warn('Errore encoding URL:', error.message);
        }
      }
      
      imageUrls.push(fullUrl);
    }
  }
  
  return [...new Set(imageUrls)];
}

async function uploadImagesToShopify(imageUrls, productId) {
  const uploadedImages = [];
  
  for (const imageUrl of imageUrls) {
    try {
      const shopifyImageData = {
        image: {
          product_id: productId,
          src: imageUrl,
          alt: 'Immagine prodotto da Senetic'
        }
      };
      
      const uploadResponse = await axios.post(
        `${SHOPIFY_STORE_URL}/admin/api/2024-04/products/${productId}/images.json`,
        shopifyImageData,
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
      
      uploadedImages.push({
        original_url: imageUrl,
        shopify_url: uploadResponse.data.image.src,
        shopify_id: uploadResponse.data.image.id
      });
      
      await new Promise(r => setTimeout(r, 100));
      
    } catch (error) {
      uploadedImages.push({
        original_url: imageUrl,
        error: error.message
      });
    }
  }
  
  return uploadedImages;
}

app.get('/', (req, res) => {
  res.json({
    message: 'Senetic-Shopify Sync API',
    endpoints: {
      'single_sync': '/sync-single-product/:sku',
      'batch_sync': '/sync-batch'
    },
    version: '2.1.0'
  });
});

app.get('/sync-single-product/:sku', async (req, res) => {
  const sku = req.params.sku;
  
  const authToken = req.headers['x-sync-token'];
  if (authToken !== process.env.SYNC_TOKEN) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }

  try {
    const [inventoryResponse, catalogueResponse] = await Promise.all([
      axios.get(
        'https://b2b.senetic.com/Gateway/ClientApi/InventoryReportGet?UseItemCategoryFilter=true&LangId=IT',
        {
          headers: {
            'accept': 'application/json',
            'Authorization': process.env.SENETIC_AUTH,
            'User-Agent': 'Mozilla/5.0'
          }
        }
      ),
      axios.get(
        'https://b2b.senetic.com/Gateway/ClientApi/ProductCatalogueGet?UseItemCategoryFilter=true&LangId=IT',
        {
          headers: {
            'accept': 'application/json',
            'Authorization': process.env.SENETIC_AUTH,
            'User-Agent': 'Mozilla/5.0'
          }
        }
      )
    ]);

    const inventoryLines = inventoryResponse.data.lines || [];
    const catalogueLines = catalogueResponse.data.lines || [];

    const prodotto = catalogueLines.find(p => p.manufacturerItemCode === sku);
    
    if (!prodotto) {
      return res.status(404).json({ 
        error: 'Prodotto non trovato su Senetic',
        sku: sku
      });
    }

    const inventoryItem = inventoryLines.find(item => item.manufacturerItemCode === sku);
    
    if (!inventoryItem) {
      return res.status(404).json({ 
        error: 'Inventario non trovato per questo prodotto',
        sku: sku
      });
    }

    const availability = inventoryItem.availability && Array.isArray(inventoryItem.availability.stockSchedules)
      ? inventoryItem.availability.stockSchedules.reduce((sum, s) => sum + (s.targetStock || 0), 0)
      : 0;

    const shopifyProduct = {
      product: {
        title: prodotto.itemDescription || '',
        body_html: prodotto.longItemDescription ? he.decode(prodotto.longItemDescription) : '',
        vendor: prodotto.productPrimaryBrand?.brandNodeName || '',
        product_type: prodotto.productSecondaryCategory?.categoryNodeName || '',
        variants: [{
          price: prodotto.unitRetailPrice ? 
            (prodotto.unitRetailPrice * (1 + (prodotto.taxRate ? prodotto.taxRate / 100 : 0))).toFixed(2) : "0.00",
          cost: prodotto.unitNetPrice ? prodotto.unitNetPrice.toString() : "0.00",
          sku: prodotto.manufacturerItemCode || '',
          barcode: prodotto.ean ? String(prodotto.ean) : '',
          inventory_quantity: availability,
          inventory_management: "shopify",
          weight: prodotto.weight ? Number(prodotto.weight) : 0,
          weight_unit: "kg",
        }]
      }
    };

    let uploadedImages = [];
    const imageUrls = extractImageUrls(prodotto.longItemDescription);

    let existingProduct = null;
    let existingVariant = null;
    let nextPageInfo = null;
    let hasNextPage = true;
    
    while (hasNextPage && !existingProduct) {
      let searchUrl = `${SHOPIFY_STORE_URL}/admin/api/2024-04/products.json?limit=250`;
      
      if (nextPageInfo) {
        searchUrl += `&page_info=${nextPageInfo}`;
      }
      
      const searchResponse = await axios.get(searchUrl, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      });

      const products = searchResponse.data.products || [];
      
      for (const product of products) {
        const variant = product.variants.find(v => v.sku === sku);
        if (variant) {
          existingProduct = product;
          existingVariant = variant;
          break;
        }
      }
      
      const linkHeader = searchResponse.headers.link;
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const nextMatch = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
        if (nextMatch) {
          nextPageInfo = nextMatch[1];
        } else {
          hasNextPage = false;
        }
      } else {
        hasNextPage = false;
      }
    }

    if (existingProduct && existingVariant) {
      const productId = existingProduct.id;
      const variantId = existingVariant.id;

      await axios.put(
        `${SHOPIFY_STORE_URL}/admin/api/2024-04/products/${productId}.json`,
        {
          product: {
            id: productId,
            title: shopifyProduct.product.title,
            body_html: shopifyProduct.product.body_html,
            vendor: shopifyProduct.product.vendor,
            product_type: shopifyProduct.product.product_type
          }
        },
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );

      await axios.put(
        `${SHOPIFY_STORE_URL}/admin/api/2024-04/variants/${variantId}.json`,
        {
          variant: {
            id: variantId,
            price: shopifyProduct.product.variants[0].price,
            cost: shopifyProduct.product.variants[0].cost,
            inventory_quantity: availability,
            barcode: shopifyProduct.product.variants[0].barcode,
            weight: shopifyProduct.product.variants[0].weight,
            weight_unit: shopifyProduct.product.variants[0].weight_unit
          }
        },
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );

      if (imageUrls.length > 0) {
        try {
          const existingImagesResponse = await axios.get(
            `${SHOPIFY_STORE_URL}/admin/api/2024-04/products/${productId}/images.json`,
            {
              headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
              }
            }
          );
          
          for (const img of existingImagesResponse.data.images) {
            await axios.delete(
              `${SHOPIFY_STORE_URL}/admin/api/2024-04/products/${productId}/images/${img.id}.json`,
              {
                headers: {
                  'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                  'Content-Type': 'application/json'
                }
              }
            );
          }
        } catch (error) {
          // Ignora errori di rimozione immagini
        }
        
        uploadedImages = await uploadImagesToShopify(imageUrls, productId);
      }

      res.json({
        success: true,
        action: 'updated',
        sku: sku,
        shopify_id: productId,
        title: shopifyProduct.product.title,
        vendor: shopifyProduct.product.vendor,
        price: shopifyProduct.product.variants[0].price,
        inventory_quantity: availability,
        images_found: imageUrls.length,
        images_uploaded: uploadedImages.filter(img => !img.error).length,
        timestamp: new Date().toISOString()
      });

    } else {
      const createResult = await axios.post(
        `${SHOPIFY_STORE_URL}/admin/api/2024-04/products.json`,
        shopifyProduct,
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );

      const newProductId = createResult.data.product.id;
  
      if (imageUrls.length > 0) {
        uploadedImages = await uploadImagesToShopify(imageUrls, newProductId);
      }

      res.json({
        success: true,
        action: 'created',
        sku: sku,
        shopify_id: createResult.data.product.id,
        title: shopifyProduct.product.title,
        vendor: shopifyProduct.product.vendor,
        price: shopifyProduct.product.variants[0].price,
        inventory_quantity: availability,
        images_found: imageUrls.length,
        images_uploaded: uploadedImages.filter(img => !img.error).length,
        timestamp: new Date().toISOString()
      });
    }

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      sku: sku,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/sync-batch', async (req, res) => {
  const authHeader = req.headers['x-cron-token'];
  if (authHeader !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Token non valido' });
  }

  const { batch = 0, size = 3 } = req.body;
  const startIndex = batch * size;

  try {
    // Stesse chiamate API del CRON esistente
    const [inventoryResponse, catalogueResponse] = await Promise.all([
      axios.get(
        'https://b2b.senetic.com/Gateway/ClientApi/InventoryReportGet?UseItemCategoryFilter=true&LangId=IT',
        {
          headers: {
            'accept': 'application/json',
            'Authorization': process.env.SENETIC_AUTH,
            'User-Agent': 'Mozilla/5.0'
          }
        }
      ),
      axios.get(
        'https://b2b.senetic.com/Gateway/ClientApi/ProductCatalogueGet?UseItemCategoryFilter=true&LangId=IT',
        {
          headers: {
            'accept': 'application/json',
            'Authorization': process.env.SENETIC_AUTH,
            'User-Agent': 'Mozilla/5.0'
          }
        }
      )
    ]);

    const inventoryLines = inventoryResponse.data.lines || [];
    const catalogueLines = catalogueResponse.data.lines || [];

    // Stessi filtri del CRON esistente
    const categorieDesiderate = [
      'Sistemi di sorveglianza',
      'Reti'
    ].map(c => c.trim().toLowerCase());

    const brandDesiderati = [
      'Dahua',
      'Hikvision',
      'Ubiquiti'
    ].map(b => b.trim().toLowerCase());

    const inventoryMap = {};
    for (const item of inventoryLines) {
      if (item.manufacturerItemCode) {
        inventoryMap[item.manufacturerItemCode] = item;
      }
    }

    const prodottiFiltrati = catalogueLines.filter(
      prodotto =>
        prodotto.productSecondaryCategory &&
        prodotto.productSecondaryCategory.categoryNodeName &&
        categorieDesiderate.includes(prodotto.productSecondaryCategory.categoryNodeName.trim().toLowerCase()) &&
        prodotto.productPrimaryBrand &&
        prodotto.productPrimaryBrand.brandNodeName &&
        brandDesiderati.includes(prodotto.productPrimaryBrand.brandNodeName.trim().toLowerCase())
    );

    // 🎯 BATCH: Prendi solo i prodotti del batch richiesto
    const prodottiDaImportare = prodottiFiltrati.slice(startIndex, startIndex + size);
    const risultati = [];

    // Processa i prodotti del batch (stessa logica del CRON)
    for (const prodotto of prodottiDaImportare) {
      const inventoryItem = inventoryMap[prodotto.manufacturerItemCode];
      if (!inventoryItem) continue;

      const availability = inventoryItem.availability && Array.isArray(inventoryItem.availability.stockSchedules)
        ? inventoryItem.availability.stockSchedules.reduce((sum, s) => sum + (s.targetStock || 0), 0)
        : 0;

      const shopifyProduct = {
        product: {
          title: prodotto.itemDescription || '',
          body_html: prodotto.longItemDescription ? he.decode(prodotto.longItemDescription) : '',
          vendor: prodotto.productPrimaryBrand?.brandNodeName || '',
          product_type: prodotto.productSecondaryCategory?.categoryNodeName || '',
          variants: [{
            price: prodotto.unitRetailPrice ? 
              (prodotto.unitRetailPrice * (1 + (prodotto.taxRate ? prodotto.taxRate / 100 : 0))).toFixed(2) : "0.00",
            cost: prodotto.unitNetPrice ? prodotto.unitNetPrice.toString() : "0.00",
            sku: prodotto.manufacturerItemCode || '',
            barcode: prodotto.ean ? String(prodotto.ean) : '',
            inventory_quantity: availability,
            inventory_management: "shopify",
            weight: prodotto.weight ? Number(prodotto.weight) : 0,
            weight_unit: "kg",
          }]
        }
      };

      let uploadedImages = [];
      const imageUrls = extractImageUrls(prodotto.longItemDescription);

      try {
        // RICERCA PRODOTTO ESISTENTE (stessa logica del CRON)
        let existingProduct = null;
        let existingVariant = null;
        let nextPageInfo = null;
        let hasNextPage = true;
        
        while (hasNextPage && !existingProduct) {
          let searchUrl = `${SHOPIFY_STORE_URL}/admin/api/2024-04/products.json?limit=250`;
          
          if (nextPageInfo) {
            searchUrl += `&page_info=${nextPageInfo}`;
          }
          
          const searchResponse = await axios.get(searchUrl, {
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
              'Content-Type': 'application/json'
            }
          });

          const products = searchResponse.data.products || [];
          
          for (const product of products) {
            const variant = product.variants.find(v => v.sku === prodotto.manufacturerItemCode);
            if (variant) {
              existingProduct = product;
              existingVariant = variant;
              break;
            }
          }
          
          const linkHeader = searchResponse.headers.link;
          if (linkHeader && linkHeader.includes('rel="next"')) {
            const nextMatch = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
            if (nextMatch) {
              nextPageInfo = nextMatch[1];
            } else {
              hasNextPage = false;
            }
          } else {
            hasNextPage = false;
          }
        }

        // UPDATE PRODOTTO ESISTENTE
        if (existingProduct && existingVariant) {
          const productId = existingProduct.id;
          const variantId = existingVariant.id;

          await axios.put(
            `${SHOPIFY_STORE_URL}/admin/api/2024-04/products/${productId}.json`,
            {
              product: {
                id: productId,
                title: shopifyProduct.product.title,
                body_html: shopifyProduct.product.body_html,
                vendor: shopifyProduct.product.vendor,
                product_type: shopifyProduct.product.product_type
              }
            },
            {
              headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
              }
            }
          );

          await axios.put(
            `${SHOPIFY_STORE_URL}/admin/api/2024-04/variants/${variantId}.json`,
            {
              variant: {
                id: variantId,
                price: shopifyProduct.product.variants[0].price,
                cost: shopifyProduct.product.variants[0].cost,
                inventory_quantity: availability,
                barcode: shopifyProduct.product.variants[0].barcode,
                weight: shopifyProduct.product.variants[0].weight,
                weight_unit: shopifyProduct.product.variants[0].weight_unit
              }
            },
            {
              headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
              }
            }
          );

          // Gestione immagini per prodotti esistenti
          if (imageUrls.length > 0) {
            try {
              const existingImagesResponse = await axios.get(
                `${SHOPIFY_STORE_URL}/admin/api/2024-04/products/${productId}/images.json`,
                {
                  headers: {
                    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                    'Content-Type': 'application/json'
                  }
                }
              );
              
              for (const img of existingImagesResponse.data.images) {
                await axios.delete(
                  `${SHOPIFY_STORE_URL}/admin/api/2024-04/products/${productId}/images/${img.id}.json`,
                  {
                    headers: {
                      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                      'Content-Type': 'application/json'
                    }
                  }
                );
              }
            } catch (error) {
              // Ignora errori di rimozione immagini
            }
            
            uploadedImages = await uploadImagesToShopify(imageUrls, productId);
          }
          
          risultati.push({
            title: shopifyProduct.product.title,
            sku: shopifyProduct.product.variants[0].sku,
            price: shopifyProduct.product.variants[0].price,
            images_uploaded: uploadedImages.filter(img => !img.error).length,
            status: 'updated',
            shopify_id: productId,
            action: 'updated'
          });

        } else {
          // CREA NUOVO PRODOTTO
          const createResult = await axios.post(
            `${SHOPIFY_STORE_URL}/admin/api/2024-04/products.json`,
            shopifyProduct,
            {
              headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
              }
            }
          );

          const newProductId = createResult.data.product.id;
  
          if (imageUrls.length > 0) {
            uploadedImages = await uploadImagesToShopify(imageUrls, newProductId);
          }
          
          risultati.push({
            title: shopifyProduct.product.title,
            sku: shopifyProduct.product.variants[0].sku,
            price: shopifyProduct.product.variants[0].price,
            images_uploaded: uploadedImages.filter(img => !img.error).length,
            status: 'created',
            shopify_id: createResult.data.product.id,
            action: 'created'
          });
        }

      } catch (err) {
        risultati.push({
          title: shopifyProduct.product?.title || 'Unknown',
          sku: prodotto.manufacturerItemCode,
          status: 'error',
          error: err.message,
          action: 'error'
        });
      }

      // Pausa tra prodotti per evitare rate limiting
      await new Promise(r => setTimeout(r, 100));
    }

    // 🎯 RISPOSTA BATCH CON STATISTICHE
    res.json({
      message: `Batch ${batch} completato`,
      batch: batch,
      processed: prodottiDaImportare.length,
      total_available: prodottiFiltrati.length,
      has_more: startIndex + size < prodottiFiltrati.length,
      risultati,
      stats: {
        created: risultati.filter(r => r.action === 'created').length,
        updated: risultati.filter(r => r.action === 'updated').length,
        errors: risultati.filter(r => r.action === 'error').length
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    res.status(500).json({ 
      error: error.toString(),
      batch: batch 
    });
  }
});

module.exports = app;