# Colori per output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🚀 Starting automated deploy...${NC}"

# Controlla se ci sono modifiche
if [ -z "$(git status --porcelain)" ]; then
  echo -e "${YELLOW}⚠️  No changes detected${NC}"
  exit 0
fi

# Richiedi messaggio di commit
if [ -z "$1" ]; then
  echo -e "${RED}❌ Usage: ./deploy.sh 'commit message'${NC}"
  exit 1
fi

COMMIT_MSG="$1"

echo -e "${YELLOW}📝 Adding files...${NC}"
git add .

echo -e "${YELLOW}💾 Committing changes...${NC}"
git commit -m "$COMMIT_MSG"

echo -e "${YELLOW}📤 Pushing to GitHub...${NC}"
git push origin main

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✅ Git push successful${NC}"
  
  echo -e "${YELLOW}🚀 Deploying to Vercel...${NC}"
  vercel --prod --force
  
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}🎉 Deploy completed successfully!${NC}"
  else
    echo -e "${RED}❌ Vercel deploy failed${NC}"
    exit 1
  fi
else
  echo -e "${RED}❌ Git push failed${NC}"
  exit 1
fi