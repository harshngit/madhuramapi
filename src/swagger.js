const swaggerJsdoc = require("swagger-jsdoc");


const options = {
	definition: {
		openapi: "3.0.0",
		info: {
			title: "Madhuram API",
			version: "1.0.0",
			description: "Full api list",
		},
		servers: [
			{
				url: "http://localhost:3000",
				description: "Local server",
			},
			{
				url: "https://api.festmate.in",
				description: "Production server",
			},
		],
		components: {
			// securitySchemes: {
			// 	bearerAuth: {
			// 		type: "http",
			// 		scheme: "bearer",
			// 		bearerFormat: "JWT",
			// 	},
			// },
		},
	},
	apis: ["./src/routes/*.js"], // it will read swagger comments from route files
};

module.exports = swaggerJsdoc(options);
