class Api::V1::ArticlesController < ApplicationController
    def index
      articles = Article.all.order(published_time: :desc)
      
      render json: articles, status: 200
    end
end
