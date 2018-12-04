class Api::V1::ArticlesController < ApplicationController
    def index
      articles = Article.all.order(published_time: :desc).first(10)

      render json: articles, status: 200
    end

    def article_comments
      comments = Article.find(params["article_id"].to_i).comments

      render json: comments, status: 200
    end  

    def show
      article = Article.find(params[:id])

      render json: article, status: 200
    end

    def get_ten
      articles = Article.all.order(published_time: :desc)

      last_article_index = articles.index { |h| h[:id] == params["article_id"].to_i}
      new_articles = articles[(last_article_index + 1)..(last_article_index + 10)]

      render json: new_articles, status: 200
    end
end
