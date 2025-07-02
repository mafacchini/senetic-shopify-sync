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
  
  // Decodifica HTML entities prima dell'analisi
  const decodedHtml = he.decode(htmlContent);
  
  const imageUrls = [];
  const imgRegex = /<img[^>]+src="([^"]+)"/gi;
  let match;
  
  // Usa l'HTML decodificato per l'analisi
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
      
      // Applica encoding solo se necessario
      if (!fullUrl.includes('%')) {
        try {
          const urlParts = fullUrl.split('senetic.pl');
          if (urlParts.length === 2) {
            const basePart = urlParts[0] + 'senetic.pl';
            const pathPart = urlParts[1];
            
            // Encode solo il path, non il dominio
            const encodedPath = pathPart.split('/').map(segment => 
              segment ? encodeURIComponent(segment) : ''
            ).join('/');
            
            fullUrl = basePart + encodedPath;
          }
        } catch (error) {
          // In caso di errore, usa l'URL originale
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
      
      // Rate limiting
      await new Promise(r => setTimeout(r, 500));
      
    } catch (error) {
      uploadedImages.push({
        original_url: imageUrl,
        error: error.message,
        shopify_error: error.response?.data
      });
    }
  }
  
  return uploadedImages;
}

app.get('/', (req, res) => {
  res.json({
    message: 'Senetic-Shopify Sync API',
    endpoints: {
      'import': '/import-shopify',
      'import_cron': '/import-shopify-cron',
      'single_sync': '/sync-single-product/:sku'
    },
    version: '2.0.0'
  });
});

app.get('/import-shopify', async (req, res) => {
  try {
    // Recupera inventario e catalogo
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

    const categorieDesiderate = [
      'Sistemi di sorveglianza',
      'Reti'
    ].map(c => c.trim().toLowerCase());

    const brandDesiderati = [
      'Dahua',
      'Hikvision',
      'Ubiquiti'
    ].map(b => b.trim().toLowerCase());

    // Crea mappa inventario
    const inventoryMap = {};
    for (const item of inventoryLines) {
      if (item.manufacturerItemCode) {
        inventoryMap[item.manufacturerItemCode] = item;
      }
    }

    const risultati = [];
    const prodottiFiltrati = catalogueLines.filter(
      prodotto =>
        prodotto.productSecondaryCategory &&
        prodotto.productSecondaryCategory.categoryNodeName &&
        categorieDesiderate.includes(prodotto.productSecondaryCategory.categoryNodeName.trim().toLowerCase()) &&
        prodotto.productPrimaryBrand &&
        prodotto.productPrimaryBrand.brandNodeName &&
        brandDesiderati.includes(prodotto.productPrimaryBrand.brandNodeName.trim().toLowerCase())
    );

    // Limita a 5 prodotti per test veloce
    const prodottiDaImportare = prodottiFiltrati.slice(0, 5);

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

        // Carica immagini
        if (imageUrls.length > 0) {
          uploadedImages = await uploadImagesToShopify(imageUrls, createResult.data.product.id);
        }

        risultati.push({
          title: shopifyProduct.product.title,
          vendor: shopifyProduct.product.vendor,
          product_type: shopifyProduct.product.product_type,
          price: shopifyProduct.product.variants[0].price,
          cost: shopifyProduct.product.variants[0].cost,
          sku: shopifyProduct.product.variants[0].sku,
          barcode: shopifyProduct.product.variants[0].barcode,
          inventory_quantity: shopifyProduct.product.variants[0].inventory_quantity,
          weight: shopifyProduct.product.variants[0].weight,
          images: {
            found: imageUrls.length,
            uploaded: uploadedImages.filter(img => !img.error).length,
            failed: uploadedImages.filter(img => img.error).length
          },
          status: 'created',
          shopify_id: createResult.data.product.id
        });

      } catch (err) {
        risultati.push({
          title: shopifyProduct.product.title,
          sku: shopifyProduct.product.variants[0].sku,
          status: 'error',
          error: err.response?.data || err.message
        });
      }

      await new Promise(r => setTimeout(r, 200));
    }

    res.json({ 
      message: 'Importazione completata!', 
      risultati,
      stats: {
        processed: prodottiDaImportare.length,
        success: risultati.filter(r => r.status === 'created').length,
        errors: risultati.filter(r => r.status === 'error').length
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

app.get('/import-shopify-cron', async (req, res) => {
  // Verifica token di sicurezza
  const authHeader = req.headers['x-cron-token'];
  if (authHeader !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Token non valido' });
  }

  try {
    // Recupera inventario e catalogo
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

    const categorieDesiderate = [
      'Sistemi di sorveglianza',
      'Reti'
    ].map(c => c.trim().toLowerCase());

    const brandDesiderati = [
      'Dahua',
      'Hikvision',
      'Ubiquiti'
    ].map(b => b.trim().toLowerCase());

    // Crea mappa inventario
    const inventoryMap = {};
    for (const item of inventoryLines) {
      if (item.manufacturerItemCode) {
        inventoryMap[item.manufacturerItemCode] = item;
      }
    }

    const risultati = [];
    const prodottiFiltrati = catalogueLines.filter(
      prodotto =>
        prodotto.productSecondaryCategory &&
        prodotto.productSecondaryCategory.categoryNodeName &&
        categorieDesiderate.includes(prodotto.productSecondaryCategory.categoryNodeName.trim().toLowerCase()) &&
        prodotto.productPrimaryBrand &&
        prodotto.productPrimaryBrand.brandNodeName &&
        brandDesiderati.includes(prodotto.productPrimaryBrand.brandNodeName.trim().toLowerCase())
    );

    // Processa fino a 20 prodotti
    const prodottiDaImportare = prodottiFiltrati.slice(0, 20);

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
        // Cerca prodotto esistente
        const searchResponse = await axios.get(
          `${SHOPIFY_STORE_URL}/admin/api/2024-04/products.json?limit=250`,
          {
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
              'Content-Type': 'application/json'
            }
          }
        );

        const allProducts = searchResponse.data.products || [];
        
        let existingProduct = null;
        let existingVariant = null;
        
        for (const product of allProducts) {
          const variant = product.variants.find(v => v.sku === prodotto.manufacturerItemCode);
          if (variant) {
            existingProduct = product;
            existingVariant = variant;
            break;
          }
        }

        if (existingProduct && existingVariant) {
          // Aggiorna prodotto esistente
          const productId = existingProduct.id;
          const variantId = existingVariant.id;

          // Aggiorna dati prodotto
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

          // Aggiorna variante
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

          // Gestisci immagini per aggiornamento
          if (imageUrls.length > 0) {
            // Rimuovi immagini esistenti
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
            
            // Carica nuove immagini
            uploadedImages = await uploadImagesToShopify(imageUrls, productId);
          }
          
          risultati.push({
            title: shopifyProduct.product.title,
            vendor: shopifyProduct.product.vendor,
            product_type: shopifyProduct.product.product_type,
            price: shopifyProduct.product.variants[0].price,
            cost: shopifyProduct.product.variants[0].cost,
            sku: shopifyProduct.product.variants[0].sku,
            barcode: shopifyProduct.product.variants[0].barcode,
            inventory_quantity: shopifyProduct.product.variants[0].inventory_quantity,
            weight: shopifyProduct.product.variants[0].weight,
            images: {
              found: imageUrls.length,
              uploaded: uploadedImages.filter(img => !img.error).length,
              failed: uploadedImages.filter(img => img.error).length
            },
            status: 'updated',
            shopify_id: productId,
            action: 'updated',
            variant_id: variantId
          });

        } else {
          // Crea nuovo prodotto
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
  
          // Carica immagini per nuovo prodotto
          if (imageUrls.length > 0) {
            uploadedImages = await uploadImagesToShopify(imageUrls, newProductId);
          }
          
          risultati.push({
            title: shopifyProduct.product.title,
            vendor: shopifyProduct.product.vendor,
            product_type: shopifyProduct.product.product_type,
            price: shopifyProduct.product.variants[0].price,
            cost: shopifyProduct.product.variants[0].cost,
            sku: shopifyProduct.product.variants[0].sku,
            barcode: shopifyProduct.product.variants[0].barcode,
            inventory_quantity: shopifyProduct.product.variants[0].inventory_quantity,
            weight: shopifyProduct.product.variants[0].weight,
            images: {
              found: imageUrls.length,
              uploaded: uploadedImages.filter(img => !img.error).length,
              failed: uploadedImages.filter(img => img.error).length
            },
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

      // Rate limiting più lungo
      await new Promise(r => setTimeout(r, 800));
    }

    res.json({ 
      message: 'Sincronizzazione CRON completata!', 
      risultati,
      stats: {
        processed: prodottiDaImportare.length,
        created: risultati.filter(r => r.action === 'created').length,
        updated: risultati.filter(r => r.action === 'updated').length,
        errors: risultati.filter(r => r.action === 'error').length,
        total_success: risultati.filter(r => r.status === 'created' || r.status === 'updated').length
      },
      type: 'cron_job',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

app.get('/sync-single-product/:sku', async (req, res) => {
  const sku = req.params.sku;
  
  // Verifica token di sicurezza
  const authToken = req.headers['x-sync-token'];
  if (authToken !== process.env.SYNC_TOKEN) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }

  try {
    // Recupera inventario e catalogo
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

    // Trova il prodotto specifico
    const prodotto = catalogueLines.find(p => p.manufacturerItemCode === sku);
    
    if (!prodotto) {
      return res.status(404).json({ 
        error: 'Prodotto non trovato su Senetic',
        sku: sku
      });
    }

    // Trova l'inventario corrispondente
    const inventoryItem = inventoryLines.find(item => item.manufacturerItemCode === sku);
    
    if (!inventoryItem) {
      return res.status(404).json({ 
        error: 'Inventario non trovato per questo prodotto',
        sku: sku
      });
    }

    // Calcola disponibilità
    const availability = inventoryItem.availability && Array.isArray(inventoryItem.availability.stockSchedules)
      ? inventoryItem.availability.stockSchedules.reduce((sum, s) => sum + (s.targetStock || 0), 0)
      : 0;

    // Costruisci prodotto Shopify
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

    // Ricerca migliorata con paginazione
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
      
      // Cerca il prodotto con la variante che ha questo SKU specifico
      for (const product of products) {
        const variant = product.variants.find(v => v.sku === sku);
        if (variant) {
          existingProduct = product;
          existingVariant = variant;
          break;
        }
      }
      
      // Controlla se ci sono altre pagine
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
      // Aggiorna prodotto esistente
      const productId = existingProduct.id;
      const variantId = existingVariant.id;

      // Aggiorna dati prodotto
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

      // Aggiorna variante
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

      // Gestisci immagini per aggiornamento
      if (imageUrls.length > 0) {
        // Rimuovi immagini esistenti
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
        
        // Carica nuove immagini
        uploadedImages = await uploadImagesToShopify(imageUrls, productId);
      }

      res.json({
        success: true,
        action: 'updated',
        sku: sku,
        shopify_id: productId,
        variant_id: variantId,
        title: shopifyProduct.product.title,
        body_html: shopifyProduct.product.body_html,
        vendor: shopifyProduct.product.vendor,
        product_type: shopifyProduct.product.product_type,
        price: shopifyProduct.product.variants[0].price,
        cost: shopifyProduct.product.variants[0].cost,
        barcode: shopifyProduct.product.variants[0].barcode,
        inventory_quantity: availability,
        inventory_management: shopifyProduct.product.variants[0].inventory_management,
        weight: shopifyProduct.product.variants[0].weight,
        weight_unit: shopifyProduct.product.variants[0].weight_unit,
        senetic_data: {
          title: prodotto.itemDescription,
          brand: prodotto.productPrimaryBrand?.brandNodeName,
          category: prodotto.productSecondaryCategory?.categoryNodeName
        },
        images: {
          found: imageUrls.length,
          uploaded: uploadedImages.filter(img => !img.error).length,
          failed: uploadedImages.filter(img => img.error).length,
          details: uploadedImages
        },
        timestamp: new Date().toISOString()
      });

    } else {
      // Crea nuovo prodotto
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
  
      // Carica immagini per nuovo prodotto
      if (imageUrls.length > 0) {
        uploadedImages = await uploadImagesToShopify(imageUrls, newProductId);
      }

      res.json({
        success: true,
        action: 'created',
        sku: sku,
        shopify_id: createResult.data.product.id,
        title: shopifyProduct.product.title,
        body_html: shopifyProduct.product.body_html,
        vendor: shopifyProduct.product.vendor,
        product_type: shopifyProduct.product.product_type,
        price: shopifyProduct.product.variants[0].price,
        cost: shopifyProduct.product.variants[0].cost,
        barcode: shopifyProduct.product.variants[0].barcode,
        inventory_quantity: availability,
        inventory_management: shopifyProduct.product.variants[0].inventory_management,
        weight: shopifyProduct.product.variants[0].weight,
        weight_unit: shopifyProduct.product.variants[0].weight_unit,
        senetic_data: {
          title: prodotto.itemDescription,
          brand: prodotto.productPrimaryBrand?.brandNodeName,
          category: prodotto.productSecondaryCategory?.categoryNodeName
        },
        images: {
          found: imageUrls.length,
          uploaded: uploadedImages.filter(img => !img.error).length,
          failed: uploadedImages.filter(img => img.error).length,
          details: uploadedImages
        },
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

module.exports = app;