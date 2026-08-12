.DEFAULT_GOAL := help

REGION       ?= ap-southeast-1
STATE_BUCKET ?= websg-custom-tfstate-273804046957
TF           := terraform -chdir=terraform
TF_VARS      ?= -var-file=prod.tfvars

.PHONY: help state-bucket package init plan apply destroy fmt validate test console frontend

FRONTEND_PORT ?= 5173

help: ## Show the available targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

state-bucket: ## Create the S3 bucket holding Terraform state (run once per account)
	@echo "Checking status of s3://$(STATE_BUCKET) in $(REGION)..."
	@if aws s3api head-bucket --bucket $(STATE_BUCKET) 2>/dev/null; then \
		echo "Bucket s3://$(STATE_BUCKET) already exists and is accessible."; \
	else \
		echo "Bucket s3://$(STATE_BUCKET) not found. Creating..."; \
		aws s3api create-bucket \
			--bucket $(STATE_BUCKET) \
			--region $(REGION) \
			--create-bucket-configuration LocationConstraint=$(REGION); \
	fi
	# Versioning lets us recover state from an accidental overwrite.
	aws s3api put-bucket-versioning \
		--bucket $(STATE_BUCKET) \
		--versioning-configuration Status=Enabled
	aws s3api put-bucket-encryption \
		--bucket $(STATE_BUCKET) \
		--server-side-encryption-configuration \
		'{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
	# State lists every resource in the account - it must never be public.
	aws s3api put-public-access-block \
		--bucket $(STATE_BUCKET) \
		--public-access-block-configuration \
		'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
	@echo "Done. Set bucket = \"$(STATE_BUCKET)\" in terraform/providers.tf"

package: ## Build the Lambda deployment package (required before plan/apply)
	cd lambda && npm run package

init: ## terraform init
	$(TF) init

plan: package ## terraform plan (prod)
	$(TF) plan $(TF_VARS)

apply: package ## terraform apply (prod)
	$(TF) apply $(TF_VARS) -auto-approve

destroy: ## terraform destroy (prod)
	$(TF) destroy $(TF_VARS)

fmt: ## Format the Terraform files
	terraform fmt -recursive terraform/

validate: ## Validate the Terraform configuration
	$(TF) validate

frontend: ## Serve the self-service portal (needs the API running with CORS_ORIGINS matching)
	@echo "Portal on http://localhost:$(FRONTEND_PORT) - API expected on http://localhost:3000"
	python3 -m http.server $(FRONTEND_PORT) --directory frontend --bind 127.0.0.1

test: ## Run the backend and lambda test suites
	cd backend && npm test
	cd lambda && npm test