# Choose an official Node.js base image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy your package files first to install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of your application code
COPY . .

# Compile your TypeScript code to JavaScript
RUN npm run build

# Expose the port your server runs on
EXPOSE 3001

# Start the server
CMD ["npm", "start"]