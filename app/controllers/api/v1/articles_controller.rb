class Api::V1::ArticlesController < ApplicationController
    def index
        articles = Article.all

        render json: articles, status: 200
    end

  def top_headlines
    n = NewsApi::Api.new
    top_headlines = n.top_headlines

    render json: top_headlines, status: 200
  end

  def all_news
    n = NewsApi::Api.new
    news = n.every_news

    render json: news, status: 200
  end
end
